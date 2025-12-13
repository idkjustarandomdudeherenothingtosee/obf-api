const fengari = require("fengari")
const lua = fengari.lua
const lauxlib = fengari.lauxlib
const lualib = fengari.lualib
const { to_luastring, to_jsstring } = fengari

const LUA_MODULES = require("./lua-bundle")

let L
let ready = false

function initLua() {
  if (ready) return

  L = lauxlib.luaL_newstate()
  lualib.luaL_openlibs(L)

  // basic polyfills expected by prometheus
  const preload = `
    arg = arg or {}
    package.preload = package.preload or {}

    if not unpack then unpack = table.unpack end
    if not loadstring then loadstring = load end

    do
    local old_random = math.random
    local max = 2147483647

    math.random = function(a, b)
        if a == nil then
            return old_random()
        end

        if b == nil then
            return old_random(1, a)
        end

        if a > b then
            a, b = b, a
        end

        a = math.floor(a)
        b = math.floor(b)

        if a < -max then a = -max end
        if b > max then b = max end

        return old_random(a, b)
    end
end

  `
  lauxlib.luaL_dostring(L, to_luastring(preload))

  // inject all prometheus lua modules
  for (const name in LUA_MODULES) {
    const code = LUA_MODULES[name]

    const wrapped = `
      package.preload["${name}"] = function()
        ${code}
      end
    `

    const status = lauxlib.luaL_dostring(L, to_luastring(wrapped))
    if (status !== 0) {
      const err = to_jsstring(lua.lua_tostring(L, -1))
      lua.lua_pop(L, 1)
      throw new Error("failed loading module " + name + ": " + err)
    }
  }

  ready = true
}

function toLuaTable(obj) {
  if (Array.isArray(obj)) {
    return `{${obj.map(toLuaTable).join(",")}}`
  }
  if (obj && typeof obj === "object") {
    return `{${Object.entries(obj)
      .map(([k, v]) => `["${k}"]=${toLuaTable(v)}`)
      .join(",")}}`
  }
  if (typeof obj === "string") {
    return `"${obj
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t")}"`
  }
  if (typeof obj === "number") return String(obj)
  if (typeof obj === "boolean") return obj ? "true" : "false"
  return "nil"
}

function obfuscate(code) {
  const escaped = code
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")

  const script = `
    local Pipeline = require("prometheus.pipeline")
    local logger = require("logger")
    logger.logLevel = 0

    local config = {
    LuaVersion = "LuaU",
    PrettyPrint = false,
    VarNamePrefix = "",
    NameGenerator = "MangledShuffled",
    InjectRuntimeModules = true,
    Seed = math.random(1, 1000000),
    Steps = {
        {
            Name = "EncryptStrings",
            Settings = {}
        },
        {
            Name = "AntiTamper",
            Settings = {
                UseDebug = false
            }
        },
        {
            Name = "Vmify",
            Settings = {}
        },
        {
            Name = "ConstantArray",
            Settings = {
                Treshold = 1,
                StringsOnly = true,
                Shuffle = true,
                Rotate = true,
                LocalWrapperTreshold = 0
            }
        },
        {
            Name = "NumbersToExpressions",
            Settings = {}
        },
        {
            Name = "WrapInFunction",
            Settings = {}
        }
    }
}


    local pipeline = Pipeline:fromConfig(config)
    return pipeline:apply("${escaped}", "input.lua")
  `

  const status = lauxlib.luaL_dostring(L, to_luastring(script))
  if (status !== 0) {
    const err = to_jsstring(lua.lua_tostring(L, -1))
    lua.lua_pop(L, 1)
    throw new Error(err)
  }

  const result = to_jsstring(lua.lua_tostring(L, -1))
  lua.lua_pop(L, 1)
  return result
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" })
    return
  }

  try {
    initLua()

    const body =
      typeof req.body === "string" ? JSON.parse(req.body) : req.body

    if (!body || typeof body.code !== "string") {
      res.status(400).json({ error: "missing code" })
      return
    }

    const output = obfuscate(body.code)

    res.status(200).json({
      success: true,
      output
    })
  } catch (e) {
    res.status(500).json({
      success: false,
      error: String(e.message || e)
    })
  }
}
