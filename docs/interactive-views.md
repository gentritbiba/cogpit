# Interactive views

An agent can put a live page in its reply: a fenced `cogpit-view` block of
HTML, CSS and JavaScript. Cogpit draws it as a card in the timeline, so an
explanation can carry sliders, charts, simulations or a 3D scene without
another app. Agents learn the syntax from the bundled `cogpit` skill
(`.claude/skills/cogpit/references/views.md`).

## How a view runs

1. `MarkdownCodeBlock` hands a `cogpit-view` block in an agent's reply to the
   lazily loaded `CogpitView`. Outside an agent's reply, such as in a prompt
   that quotes one, it stays code. Until the reply writes the closing fence,
   the card says the view is being built instead of running half a page.
2. The card frames `/api/views/shell/v1` (`server/views/shell.ts`) with
   `sandbox="allow-scripts"`. The shell answers `ready`; the card then posts the
   composed page (`view/document.ts`: theme, base stylesheet, the in-frame kit
   and the agent's markup as the body) and the code of the libraries it uses.
3. The shell's bridge turns each library into a blob URL, swaps the
   `cogpit:lib/<name>` placeholders for them, and writes the page over itself.

The kit gives the page `window.cogpit` (`theme`, `color`, `onTheme`, `ask`),
reports its height and script errors, and routes link clicks to the parent.

## Security model

The frame has an opaque origin: no cookies, storage or access to Cogpit's DOM
and API. The shell's policy allows inline and blob scripts but no network
(`connect-src`, `img-src`, `font-src` and `media-src` take only `data:` and
`blob:`), no forms, no nested frames and framing only by Cogpit itself. The
desktop app also refuses any navigation of the frame away from the shell.

The parent trusts nothing a view posts, because the view's own code can post
the same messages as the kit: sizes are clamped, errors truncated, links must be
plain `http(s)` without credentials, and `open` and `ask` act only while the
frame holds focus, which a page cannot take without the user's click. `ask` only
fills the composer; the user still sends.

Share guests cannot load the shell, so a view in a shared session shows that it
could not load and offers its source.

## Libraries

D3, KaTeX (MathML output, so no fonts or stylesheet) and Three.js with
`OrbitControls` ship with the renderer as lazily loaded raw chunks
(`view/libraries.ts`). `build/viewLibraryAliases.ts` maps `@view-lib/<name>` to
the browser builds, which the packages' export maps do not expose. To add one,
add its file there, a loader in `libraries.ts`, its name in `librariesUsed`, and
a row in the skill's table.
