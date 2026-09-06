use crate::AppState;
use tauri::{AppHandle, Manager};
use tiny_http::{Header, Method, Response, Server};

const PORT: &str = "127.0.0.1:34572";

pub fn start(app: AppHandle) {
    let server = match Server::http(PORT) {
        Ok(s) => s,
        Err(e) => {
            log::warn!(target: "LocalStats", "bind_failed port={PORT} err={e}");
            return;
        }
    };
    log::info!(target: "LocalStats", "listening port={PORT}");

    for request in server.incoming_requests() {
        let method = request.method().clone();
        let url = request.url().to_string();

        if method == Method::Options {
            respond_cors(request);
            continue;
        }

        if method.as_str() == "GET" && url == "/local-stats" {
            let payload = collect_stats(&app);
            respond_json(request, &payload);
        } else {
            respond_error(request, 404, "not found");
        }
    }
}

fn collect_stats(app: &AppHandle) -> serde_json::Value {
    let (items, collections) = {
        let state = app.state::<AppState>();
        let db = state.db.lock().unwrap();
        let items: i64 = db
            .query_row("SELECT COUNT(*) FROM inspirations", [], |r| r.get(0))
            .unwrap_or(0);
        let collections: i64 = db
            .query_row("SELECT COUNT(*) FROM collections", [], |r| r.get(0))
            .unwrap_or(0);
        (items, collections)
    };

    let storage_bytes: u64 = crate::vault::get_vault_path(app)
        .map(|p| crate::vault::dir_size_bytes(&p))
        .unwrap_or(0);

    serde_json::json!({
        "app_running": true,
        "items": items,
        "collections": collections,
        "storage_bytes": storage_bytes,
    })
}

fn cors_headers() -> Vec<Header> {
    vec![
        Header::from_bytes(b"Content-Type", b"application/json").unwrap(),
        Header::from_bytes(b"Access-Control-Allow-Origin", b"*").unwrap(),
        Header::from_bytes(b"Access-Control-Allow-Methods", b"GET, OPTIONS").unwrap(),
        Header::from_bytes(b"Access-Control-Allow-Headers", b"Content-Type").unwrap(),
    ]
}

fn respond_json(request: tiny_http::Request, value: &serde_json::Value) {
    let body = value.to_string();
    let mut r = Response::from_string(body);
    for h in cors_headers() {
        r = r.with_header(h);
    }
    request.respond(r).ok();
}

fn respond_cors(request: tiny_http::Request) {
    let mut r = Response::empty(204);
    for h in cors_headers() {
        r = r.with_header(h);
    }
    request.respond(r).ok();
}

fn respond_error(request: tiny_http::Request, code: u16, msg: &str) {
    let body = serde_json::json!({ "error": msg }).to_string();
    let mut r = Response::from_string(body).with_status_code(code);
    for h in cors_headers() {
        r = r.with_header(h);
    }
    request.respond(r).ok();
}
