export const config = {
  api: {
    bodyParser: false
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).end("method not allowed")
  }

  let raw = ""
  for await (const chunk of req) raw += chunk
  let code = raw.toString()
  if (!code.trim()) return res.status(400).end("empty body")

  let fixmode = req.query.fix === "true"
  let rcmode = req.query.rc === "true"

  let lines = code.split("\n")

  let globalscope = new Map()
  let functionlocals = []
  let localusage = new Map()
  let hoisted = new Set()
  let removals = new Set()
  let diagnostics = []

  function markuse(name) {
    localusage.set(name, (localusage.get(name) || 0) + 1)
  }

  function diag(msg) {
    diagnostics.push(msg)
  }

  let currentfn = null

  for (let i = 0; i < lines.length; i++) {
    let rawline = lines[i]
    let line = rawline.trim()

    if (!line || line.startsWith("--")) continue

    if (/^function\b|=\s*function\b/.test(line)) {
      currentfn = { locals: new Set(), line: i + 1 }
      functionlocals.push(currentfn)
    }

    if (/^end\b/.test(line)) {
      currentfn = null
    }

    let localmatch = line.match(/^local\s+([a-zA-Z_][a-zA-Z0-9_]*)/)
    if (localmatch) {
      let name = localmatch[1]

      if (currentfn) {
        currentfn.locals.add(name)
      } else {
        if (globalscope.has(name)) {
          diag(`duplicate local ${name} removed`)
          removals.add(i)
        } else {
          globalscope.set(name, i)
        }
      }
      localusage.set(name, 0)
      continue
    }

    let assign = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=/)
    if (assign) {
      let name = assign[1]
      if (globalscope.has(name) && currentfn) {
        hoisted.add(name)
      }
      markuse(name)
    }

    let reads = line.matchAll(/\b([a-zA-Z_][a-zA-Z0-9_]*)\b/g)
    for (let r of reads) markuse(r[1])

    if (/:Get(Children|Descendants|Players)\(\)/.test(line)) {
      diag("large table detected, converting to lazy cache")
    }
  }

  for (let [name, count] of localusage.entries()) {
    if (count === 0 && globalscope.has(name)) {
      removals.add(globalscope.get(name))
      diag(`unused local ${name} removed`)
    }
  }

  let output = []

  let hoistheader = []
  for (let name of hoisted) {
    hoistheader.push(`local ${name}`)
    diag(`hoisted shared local ${name}`)
  }

  if (hoistheader.length) {
    output.push(...hoistheader, "")
  }

  for (let i = 0; i < lines.length; i++) {
    if (removals.has(i)) continue

    let line = lines[i]

    if (rcmode) {
      if (line.trim().startsWith("--")) continue
      line = line.replace(/--.*$/g, "")
    }

    if (/:Get(Children|Descendants|Players)\(\)/.test(line)) {
      let varname = `__cache_${i}`
      output.push(
        `local ${varname} = setmetatable({}, { __mode = "k" })`,
        `for _,v in ipairs(${line.trim()}) do ${varname}[v] = true end`
      )
      continue
    }

    output.push(line)
  }

  if (!fixmode && !rcmode) {
    return res.status(200).json({
      ok: true,
      diagnostics
    })
  }

  let analysisheader = [
    "--[[",
    "analysis",
    "",
    ...diagnostics,
    "--]]",
    ""
  ]

  let rcheader = [
    "--[[",
    "rc",
    "comments removed: " + rcmode,
    "optimizer enabled: true",
    "--]]",
    ""
  ]

  let finalcode = []
  if (fixmode) finalcode.push(...analysisheader)
  if (rcmode) finalcode.push(...rcheader)
  finalcode.push(...output)

  res.status(200).end(finalcode.join("\n"))
}
