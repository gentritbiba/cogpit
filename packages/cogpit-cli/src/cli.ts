import { run } from "./index"

process.exitCode = await run(process.argv.slice(2))
