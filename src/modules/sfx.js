const VOL = 0.10

function play(name) {
  const a = new Audio(`/assets/audio/${name}.aac`)
  a.volume = VOL
  a.play().catch(() => {})
}

export const sfx = {
  delete:  () => play('delete'),
  success: () => play('success'),
  warning: () => play('warning'),
}
