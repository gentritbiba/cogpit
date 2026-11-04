/**
 * Skill files earlier releases installed and this one no longer ships, with the
 * SHA-256 of every version they shipped. The standalone cogpit-browser,
 * cogpit-sessions and cogpit-memory skills are now references inside `cogpit`.
 * Frozen: nothing new is ever added here.
 */
export const RETIRED_SKILL_FILES: Readonly<Record<string, readonly string[]>> = {
  "cogpit-browser/SKILL.md": [
    "4ee9e14accac2b1e93c1521a207f2528c94c3f6bd9c2ea38c7969e8496f997bc",
  ],
  "cogpit-browser/references/advanced.md": [
    "fb1e6cb6a4647bdf82a442fc504d28b378c7fac12e0ba29fa01b0c549fb454ae",
  ],
  "cogpit-sessions/SKILL.md": [
    "0eb422d407f4ebd843a5725896c5667c07992e5c7a68f8460ba968ba336d30ed",
    "775d4ea64d17838a2f76170462c9e3936f504ddfce083849e2ac398c6df4ae96",
    "809191a0c38f36cd574c05bf108e469249d29eb6ad19dec15d0f61dcfef1a694",
    "91681b08d0c073131be6f9af8e72472e4854736e9aceb826f5c03937cbb88735",
    "9f89ec9bac648ca1cd4a5091184fcb5c53fcc36c16617b163225864b51640b18",
  ],
  "cogpit-sessions/references/remote-workspaces.md": [
    "8be0dc777d1c554675c3d8a3b5a344998a94a6b6db467022c11c2ffe1e0230e5",
  ],
  "cogpit-memory/SKILL.md": [
    "1fe487f4daeb6dbdad5de25a1e2d680607f5f1115377751d091ab5db8e49b511",
  ],
  "cogpit/references/cogpit-sessions.md": [
    "07c55005219d87add929164e55ac73b689c517f2e9da35f222fdf9d191d671c0",
    "8c96ef073c61e89bdb0bb6bf8b012c019deb27dd7987b98200f2f33ba2109cad",
    "a2e956cf6bd0972922ab22cf84f2d582ebc0c6a7613d1e4a5f72b2f84cb257d4",
    "c6224ad2236357d1f5b03d83c37664ff21cc5ea3c9810bad33b969613782e449",
    "dae23a7c89801b7e85712605d041d99e5174c615045e3fcfc3d19db8af91ede5",
  ],
  "cogpit/references/cogpit-memory.md": [
    "deb58baff03a93c51f6934e7ec036be8a6b293e8705d2fe69533f46424aded93",
  ],
}

/** Directories those files lived in, deepest first; each goes only once empty. */
export const RETIRED_SKILL_DIRS = [
  "cogpit-browser/references",
  "cogpit-browser",
  "cogpit-sessions/references",
  "cogpit-sessions",
  "cogpit-memory",
] as const
