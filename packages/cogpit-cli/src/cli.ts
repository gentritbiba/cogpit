import { run } from "./index"
import { quietSqliteWarning } from "./warnings"

quietSqliteWarning(process)
process.exitCode = await run(process.argv.slice(2))
