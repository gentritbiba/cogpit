import { join } from "node:path";

type AuditSeverity = "critical" | "high" | "moderate" | "low";
type AcceptedSeverity = Exclude<AuditSeverity, "critical">;

const severityRank: Record<AuditSeverity, number> = {
  low: 0,
  moderate: 1,
  high: 2,
  critical: 3,
};

interface AuditFinding {
  id: number;
  severity: AuditSeverity;
  title: string;
  url: string;
}

type AuditReport = Record<string, AuditFinding[]>;

interface AuditTarget {
  label: string;
  cwd: string;
  acceptedFindings: ReadonlyMap<string, AcceptedSeverity>;
}

// These findings currently have no compatible patched release in their
// dependency line. Keep each allowance package-, advisory-, and
// severity-specific: new advisories and severity escalations must fail CI.
const repoRoot = join(import.meta.dir, "..");
const targets: AuditTarget[] = [
  {
    label: "application",
    cwd: repoRoot,
    acceptedFindings: new Map([
      ["@babel/core:1123528", "low"],
      // Windows-only path traversal in serve-static; fixed only in the 2.x
      // major, which @modelcontextprotocol/sdk still pins out of (^1.19.9).
      // Reaches the tree solely through that SDK — Cogpit never constructs a
      // Hono server and never imports serve-static, so no route is exposed.
      // (Previously justified by "ships no Windows builds", which stopped
      // being true when the NSIS target started shipping.)
      ["@hono/node-server:1124006", "moderate"],
      ["ip-address:1118827", "moderate"],
      // DoS via unbounded brace expansion — one advisory per affected major
      // (<1.1.17, 2.0.0–2.1.2, 4.0.0–5.0.7). Every copy arrives through build
      // tooling (electron-builder, eslint, ts-morph, typescript-eslint), is
      // never bundled into the app or reachable from a request, and expands
      // repo globs rather than untrusted input.
      //
      // Patched releases now exist in all three lines (1.1.17, 2.1.3, 5.0.8)
      // and every dependent's caret range already admits them — only stale
      // lockfile resolutions pin the old ones. Refreshing those re-resolves
      // the whole lockfile, so it is tracked as follow-up work rather than
      // done during a release cut.
      ["brace-expansion:1130588", "high"],
      ["brace-expansion:1130589", "high"],
      ["brace-expansion:1130591", "high"],
    ]),
  },
  {
    label: "cogpit-memory",
    cwd: join(repoRoot, "packages/cogpit-memory"),
    acceptedFindings: new Map([
      ["esbuild:1120680", "low"],
    ]),
  },
];

let failed = false;

for (const target of targets) {
  const audit = Bun.spawnSync(["bun", "audit", "--json"], {
    cwd: target.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = audit.stdout.toString().trim();
  let report: AuditReport;

  try {
    report = JSON.parse(stdout) as AuditReport;
  } catch {
    const stderr = audit.stderr.toString().trim();
    console.error(`[${target.label}] Unable to parse \`bun audit --json\` output.`);
    if (stderr) console.error(stderr);
    failed = true;
    continue;
  }

  const findings = Object.entries(report).flatMap(([packageName, packageFindings]) =>
    packageFindings.map((finding) => ({ packageName, finding })),
  );
  const unexpected = findings.filter(({ packageName, finding }) => {
    const expectedSeverity = target.acceptedFindings.get(`${packageName}:${finding.id}`);
    return expectedSeverity === undefined
      || severityRank[finding.severity] > severityRank[expectedSeverity];
  });
  const observedFindingKeys = new Set(
    findings.map(({ packageName, finding }) => `${packageName}:${finding.id}`),
  );
  const staleAllowances = [...target.acceptedFindings.keys()].filter(
    (findingKey) => !observedFindingKeys.has(findingKey),
  );

  if (unexpected.length > 0 || staleAllowances.length > 0) {
    console.error(`[${target.label}] Dependency audit found new, escalated, or critical advisories:`);
    for (const { packageName, finding } of unexpected) {
      const expectedSeverity = target.acceptedFindings.get(`${packageName}:${finding.id}`);
      const baseline = expectedSeverity ? ` (maximum accepted: ${expectedSeverity})` : "";
      console.error(`- ${packageName} [${finding.severity}]${baseline} ${finding.url}`);
    }
    for (const findingKey of staleAllowances) {
      console.error(`- stale audit allowance: ${findingKey}`);
    }
    failed = true;
    continue;
  }

  const counts = findings.reduce<Record<AuditSeverity, number>>(
    (result, { finding }) => {
      result[finding.severity] += 1;
      return result;
    },
    { critical: 0, high: 0, moderate: 0, low: 0 },
  );

  console.log(
    `[${target.label}] Dependency audit ratchet passed: ${findings.length} accepted findings ` +
      `(${counts.critical} critical, ${counts.high} high, ` +
      `${counts.moderate} moderate, ${counts.low} low).`,
  );
}

if (failed) process.exit(1);
