import fengari from "fengari"

const { lauxlib, lualib, to_luastring } = fengari

let luaReady = false
let L

export default function handler(req, res) {
  try {
    if (!luaReady) {
      L = lauxlib.luaL_newstate()
      lualib.luaL_openlibs(L)
      lauxlib.luaL_dostring(L, to_luastring("x = 1 + 2"))
      luaReady = true
    }

    res.json({ ok: true, fengari: true })
  } catch (e) {
    res.status(500).json({ error: String(e) })
  }
}
