const fs = require("fs")
const path = require("path")
const assert = require("assert")

const configPath = path.resolve(__dirname, "../dashboard/vite.config.ts")
const config = fs.readFileSync(configPath, "utf8")

assert(
  config.includes("loadEnv(mode, process.cwd(), '')"),
  "dashboard vite config must load env variables from the Vite cwd"
)
assert(
  config.includes("VITE_STATUS_API_TARGET"),
  "dashboard proxy target must be controlled by VITE_STATUS_API_TARGET"
)
assert(
  config.includes("http://127.0.0.1:3458"),
  "dashboard proxy target must default to localhost status API"
)
assert(
  !config.includes("http://192.168.0.104:3458"),
  "dashboard proxy target must not hardcode a LAN IP"
)
assert(
  config.includes('target: statusApiTarget'),
  "dashboard proxy entries must use the configurable statusApiTarget"
)

console.log("dashboard proxy config check passed")
