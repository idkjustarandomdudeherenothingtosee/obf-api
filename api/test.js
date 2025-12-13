const fengari = require("fengari")
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari

let L
let ready = false

module.exports = function handler(req, res) {
  try {
    if (!ready) {
      L = lauxlib.luaL_newstate()
      lualib.luaL_openlibs(L)

      // preload ONE lua module
      const preloadModule = `
        package.preload["testmod"] = function()
          return {
            add = function(a, b)
              return a + b
            end
          }
        end
      `
      lauxlib.luaL_dostring(L, to_luastring(preloadModule))

      ready = true
    }

    const status = lauxlib.luaL_dostring(
      L,
      to_luastring(`
        local m = require("testmod")
        return m.add(5, 7)
      `)
    )

    if (status !== 0) {
      const err = to_jsstring(lua.lua_tostring(L, -1))
      lua.lua_pop(L, 1)
      throw new Error(err)
    }

    const result = lua.lua_tonumber(L, -1)
    lua.lua_pop(L, 1)

    res.json({
      ok: true,
      moduleResult: result
    })
  } catch (e) {
    res.status(500).json({
      error: String(e.message || e)
    })
  }
}
