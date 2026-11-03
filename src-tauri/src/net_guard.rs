// Downloads come from the public internet only. A web page decides what the browser
// extension saves (an image's address, a video's address), and the phone and the
// import box pass links too — without this, a page could make qooti fetch something
// on the user's own network: a router's admin page, a NAS, another program on this
// computer.
//
// Three layers: `is_private_literal` on the request path (no DNS, instant),
// `check_public_url` before a download starts (resolves the name), and `agent()` for
// qooti's own HTTP fetches, which refuses private addresses on every connection —
// redirects and names that change their answer included. yt-dlp makes its own
// connections; it gets the start-of-download check.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs};

/// The error the app and the extension turn into plain words.
pub const PRIVATE_ADDRESS: &str = "PRIVATE_ADDRESS";

pub fn is_blocked_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_blocked_v4(v4),
        IpAddr::V6(v6) => is_blocked_v6(v6),
    }
}

fn is_blocked_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    ip.is_unspecified() || ip.is_loopback() || ip.is_private() || ip.is_link_local()
        || ip.is_broadcast() || ip.is_multicast() || ip.is_documentation()
        || a == 0                                   // "this network"
        || (a == 100 && (64..=127).contains(&b))    // carrier-grade NAT
        || (a == 192 && b == 0 && c == 0)           // IETF protocol assignments
        || (a == 198 && (b == 18 || b == 19))       // benchmarking
        || a >= 240                                 // reserved
}

fn is_blocked_v6(ip: Ipv6Addr) -> bool {
    if let Some(v4) = ip.to_ipv4_mapped() { return is_blocked_v4(v4) }
    let s = ip.segments();
    let embedded_v4 = || Ipv4Addr::new((s[6] >> 8) as u8, s[6] as u8, (s[7] >> 8) as u8, s[7] as u8);
    ip.is_unspecified() || ip.is_loopback() || ip.is_multicast()
        || (s[0] & 0xfe00) == 0xfc00                            // unique local fc00::/7
        || (s[0] & 0xffc0) == 0xfe80                            // link-local fe80::/10
        || (s[0] == 0x2001 && s[1] == 0x0db8)                   // documentation
        || s[..6] == [0, 0, 0, 0, 0, 0]                         // ::a.b.c.d (old IPv4-compatible)
        || (s[0] == 0x64 && s[1] == 0xff9b && s[2..6] == [0, 0, 0, 0] && is_blocked_v4(embedded_v4()))  // NAT64 of a private address
}

/// Names that only mean something on the local network.
fn is_local_name(host: &str) -> bool {
    let h = host.trim_end_matches('.').to_ascii_lowercase();
    !h.contains('.')                                   // a bare machine name ("nas", "router")
        || ["localhost", ".localhost", ".local", ".lan", ".internal", ".home.arpa"]
            .iter().any(|s| if s.starts_with('.') { h.ends_with(s) } else { h == *s })
}

fn host_of(url: &str) -> Option<(String, u16)> {
    let u = tauri::Url::parse(url).ok()?;
    let host = u.host_str()?.trim_start_matches('[').trim_end_matches(']').to_string();
    Some((host, u.port_or_known_default().unwrap_or(443)))
}

/// Instant check, no DNS: the address is a private IP or a local network name.
/// The URL parser turns every way of writing an IPv4 address (decimal, hex…) into
/// the dotted form first, so those can't slip past.
pub fn is_private_literal(url: &str) -> bool {
    let Some((host, _)) = host_of(url) else { return false };
    match host.parse::<IpAddr>() {
        Ok(ip) => is_blocked_ip(ip),
        Err(_) => is_local_name(&host),
    }
}

/// Full check before a download: fine only when every address the name points to is
/// on the public internet. A name that can't be resolved is left to the downloader,
/// which reports it as a connection problem.
pub fn check_public_url(url: &str) -> Result<(), &'static str> {
    if is_private_literal(url) { return Err(PRIVATE_ADDRESS) }
    let Some((host, port)) = host_of(url) else { return Ok(()) };
    if host.parse::<IpAddr>().is_ok() { return Ok(()) }   // a public literal
    match (host.as_str(), port).to_socket_addrs() {
        Ok(addrs) => {
            let addrs: Vec<SocketAddr> = addrs.collect();
            if addrs.iter().any(|a| is_blocked_ip(a.ip())) { Err(PRIVATE_ADDRESS) } else { Ok(()) }
        }
        Err(_) => Ok(()),
    }
}

/// Resolves names for qooti's own HTTP client and keeps public addresses only, so a
/// fetch can't be steered to the local network — not by a redirect, and not by a name
/// that answers differently the second time.
struct PublicOnly;

impl ureq::Resolver for PublicOnly {
    fn resolve(&self, netloc: &str) -> std::io::Result<Vec<SocketAddr>> {
        let public: Vec<SocketAddr> = netloc.to_socket_addrs()?.filter(|a| !is_blocked_ip(a.ip())).collect();
        if public.is_empty() {
            return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, PRIVATE_ADDRESS));
        }
        Ok(public)
    }
}

/// An HTTP client that only talks to the public internet. Use it for every fetch of
/// an address that came from a page, the phone or a pasted link.
pub fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new().resolver(PublicOnly).build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_and_special_addresses_are_blocked() {
        for ip in ["127.0.0.1", "10.0.0.8", "172.16.4.1", "172.31.255.255", "192.168.1.1", "169.254.169.254",
                   "100.64.0.1", "0.0.0.0", "255.255.255.255", "224.0.0.1", "192.0.2.10", "198.18.0.1", "240.0.0.1",
                   "::1", "::", "fe80::1", "fd12:3456::1", "::ffff:192.168.0.1", "::ffff:127.0.0.1", "64:ff9b::a00:1", "2001:db8::1"] {
            assert!(is_blocked_ip(ip.parse().unwrap()), "{ip} should be blocked");
        }
    }

    #[test]
    fn public_addresses_pass() {
        for ip in ["8.8.8.8", "142.250.74.14", "151.101.1.140", "172.32.0.1", "100.128.0.1", "2606:4700::6810:84e5", "::ffff:8.8.8.8", "64:ff9b::808:808"] {
            assert!(!is_blocked_ip(ip.parse().unwrap()), "{ip} should be allowed");
        }
    }

    #[test]
    fn literal_check_catches_every_spelling() {
        for url in ["http://192.168.1.1/admin", "http://2130706433/", "http://0x7f000001/", "http://127.1/",
                    "http://[::1]:8080/x", "https://localhost/a.jpg", "http://router/", "http://nas.local/p.png",
                    "http://printer.lan/", "http://media.home.arpa/x.mp4", "http://169.254.169.254/latest/meta-data/"] {
            assert!(is_private_literal(url), "{url} should be caught");
        }
        for url in ["https://i.pinimg.com/originals/a.jpg", "https://www.youtube.com/watch?v=x", "http://8.8.8.8/", "https://cdn.cosmos.so/x"] {
            assert!(!is_private_literal(url), "{url} should pass");
        }
    }

    #[test]
    fn resolving_check_refuses_names_that_point_home() {
        assert_eq!(check_public_url("http://localhost:1420/extension/ping"), Err(PRIVATE_ADDRESS));
        assert_eq!(check_public_url("http://127.0.0.1/"), Err(PRIVATE_ADDRESS));
        assert_eq!(check_public_url("https://8.8.8.8/"), Ok(()));
        // An unresolvable name is the downloader's problem, not this check's
        assert_eq!(check_public_url("https://does-not-exist.invalid/x.jpg"), Ok(()));
    }

    #[test]
    fn the_client_refuses_private_hosts() {
        let err = agent().get("http://127.0.0.1:9/").call().unwrap_err();
        assert!(err.to_string().contains(PRIVATE_ADDRESS), "{err}");
    }
}
