# Third-party notices

ImageStep ships other people's work in six places: the console at `imagestep.dev`
(the JavaScript every visitor downloads, plus the fonts served from our own
origin) and the five packages this product publishes — npm `imagestep`,
`imagestep-cli`, `@imagestep/mcp` and `n8n-nodes-imagestep`, and PyPI
`imagestep`.

This file is the **single source of truth** for what that work is and under which
licence it travels. It reaches the two audiences two different ways, and neither
is a retype: `/licenses` on the site renders this same file as the page you may
be reading it on — the headings and tables below become headings and tables, and
every licence text is a fenced block, which is what keeps the part that must be
word-for-word word-for-word — and every published package carries a
byte-identical copy, written by `scripts/sync-notices.mjs` (§3).

Nothing here is optional politeness. MIT, ISC, BSD-3-Clause, Apache 2.0 and the
SIL Open Font License each make passing the notice on a **condition** of
redistribution, and this repo distributes to two audiences at once (a public
website and two package registries). §5 carries all five texts.

The judgement that decides what belongs here is one question: **do these bytes
leave our machines?** §4 lists the things that answer _no_ — running software as
a network service is not distribution — because "we thought about it and left it
out" and "we forgot" look identical in a file.

---

## 1. The console's browser bundle

Everything under this heading is compiled into the JavaScript served to every
visitor of `imagestep.dev`. Verified against the built chunks rather than the
dependency list: `pnpm --filter imagestep-console build`, then grep the emitted
`.next/static/chunks/` for each library's runtime markers. A `package.json`
dependency that never reaches the browser belongs in §4, not here.

| Package                                                          | Version | Licence                                           |
| ---------------------------------------------------------------- | ------- | ------------------------------------------------- |
| [react](https://github.com/facebook/react)                       | 19.3.0  | MIT — © Meta Platforms, Inc. and affiliates       |
| [react-dom](https://github.com/facebook/react)                   | 19.3.0  | MIT — © Meta Platforms, Inc. and affiliates       |
| [next](https://github.com/vercel/next.js)                        | 16.3.6  | MIT — © 2025 Vercel, Inc.                         |
| [radix-ui](https://github.com/radix-ui/primitives)               | 1.6.7   | MIT — © 2022 WorkOS                               |
| [lucide-react](https://github.com/lucide-icons/lucide)           | 1.48.0  | ISC — © 2026 Lucide Icons and Contributors — §5.1 |
| [class-variance-authority](https://github.com/joe-bell/cva)      | 0.7.1   | Apache-2.0 — §5.2                                 |
| [clsx](https://github.com/lukeed/clsx)                           | 2.1.1   | MIT — © Luke Edwards                              |
| [tailwind-merge](https://github.com/dcastil/tailwind-merge)      | 3.7.0   | MIT — © 2021 Dany Castillo                        |
| [sonner](https://github.com/emilkowalski/sonner)                 | 2.0.8   | MIT — © 2023 Emil Kowalski                        |
| [next-themes](https://github.com/pacocoursey/next-themes)        | 0.4.6   | MIT — © 2022 Paco Coursey                         |
| [react-virtuoso](https://github.com/petyosi/react-virtuoso)      | 4.18.15 | MIT — © 2020 Petyo Ivanov                         |
| [@virtuoso.dev/masonry](https://github.com/virtuoso-dev/masonry) | 1.4.3   | MIT — © Petyo Ivanov                              |
| [minisearch](https://github.com/lucaong/minisearch)              | 7.2.0   | MIT — © 2022 Luca Ongaro                          |
| [fflate](https://github.com/101arrowz/fflate)                     | 0.8.3   | MIT — © 2026 Arjun Barrett                        |

Since #106 the console mounts its account pages (login, sign-out, privacy & data)
from **site-kit**, which ships SOURCE and is compiled into this bundle, so the
libraries those pages stand on are served from this origin too:

| Package                                                               | Version | Licence                                |
| --------------------------------------------------------------------- | ------- | -------------------------------------- |
| [react-hook-form](https://github.com/react-hook-form/react-hook-form) | 7.89.0  | MIT — © 2019-present Beier(Bill) Luo   |
| [@hookform/resolvers](https://github.com/react-hook-form/resolvers)   | 5.9.1   | MIT — © 2019-present Beier(Bill) Luo   |
| [zod](https://github.com/colinhacks/zod)                              | 4.6.5   | MIT — © 2025 Colin McDonnell           |
| [date-fns](https://github.com/date-fns/date-fns)                      | 4.4.0   | MIT — © 2021 Sasha Koss and Lesha Koss |

All four were verified in the built chunks the same way as the rows above, not
inferred from the manifest: `shouldUnregister` (react-hook-form), `ZodError` and
`invalid_type` (zod) and the en-US month and weekday tables (date-fns) all appear
in `.next/static/chunks/`. Radix used to be three more rows here — the kit asked
for `@radix-ui/react-dialog`, `-label` and `-slot` by name, so this console
shipped them _alongside_ the single `radix-ui` package it already used, two
copies of the same primitives in one bundle. site-kit v0.63.0 moved the kit onto
`radix-ui`, so §5.3's row above covers it once. All four arrive
because the kit's `createAccountUi` builds every page it offers — including the
contact form this console does not mount — so they ship whether or not a visitor
can reach the surface that uses them.

**`@jun/site-kit` itself is credited nowhere, and that is correct**: it is our own
private package, and it has no `dependencies` of its own — only peers, every one
of which is a row in this section. The name is here so that the derivation in
`apps/console/test/unit/licenses.test.js` sees it accounted for rather than
missing.

The MIT text is the same for all MIT rows but the copyright line is not, so
each is named above; the licence body is §5.3, quoted once.

`class-variance-authority` ships no `NOTICE` file, so Apache-2.0 §4(d) adds
nothing beyond §5.2 here. If a future Apache-2.0 dependency does ship one, its
`NOTICE` has to be reproduced too — that is the clause, and it is the one people
miss.

## 2. Fonts — IBM Plex Sans, IBM Plex Mono and Literata

**SIL Open Font License 1.1** · <https://github.com/IBM/plex> ·
<https://github.com/googlefonts/literata>

| Family        | Copyright line, read from the `.woff2` we serve |
| ------------- | ----------------------------------------------- |
| IBM Plex Sans | Copyright 2019 IBM Corp. All rights reserved.   |
| IBM Plex Mono | Copyright 2017 IBM Corp. All rights reserved.   |
| Literata      | Copyright 2017 The Literata Project Authors     |

**Three faces, three copyright lines, none of them written from memory.** The
`name` table of each file we serve is the authority here: Plex Sans's current
release states 2019, Plex Mono's states 2017, and one line covering both is
wrong for one of them; Literata's states 2017 and names **The Literata Project
Authors**, not Google. Three sibling repos have shipped a wrong year or a wrong
holder written from memory of the project; the console's unit tests read every
committed font file and `pnpm verify:notices` every built one, and both fail
when this table stops matching them.

The Reserved Font Names differ too, and only the Plex files have one: "Plex" is
reserved, **Literata's binaries declare none**. That is a licence fact, not
trivia — an RFN forbids shipping a self-modified subset under the original name
(OFL §3), which is why every subset we ship is Google's own file forwarded
unchanged rather than one we re-cut.

The files are Google Fonts' own subsets — every subset Google serves for each
family: Plex Sans and Literata as one variable file per subset (Literata with its
optical-size axis), Plex Mono as its 400 and 600 instances — committed as Google
serves them under `apps/console/src/fonts/` and loaded through `next/font/local`.
Committing them keeps Google out of the build as well: `next/font/google` would
fetch these same bytes on every build, and a malformed Google response fails it
(vercel/next.js#99114). The `.woff2` files are served from `imagestep.dev`
itself — no request goes to Google Fonts, which is what `/privacy` says and why
this row exists. Full text: §5.4.

## 3. The five published packages

| Package               | Registry | Redistributes                                                                                                                      |
| --------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `imagestep`           | npm      | nothing — zero runtime dependencies                                                                                                |
| `n8n-nodes-imagestep` | npm      | nothing — zero runtime dependencies, by design (the n8n Creator Portal reviews the tree)                                           |
| `@imagestep/mcp`      | npm      | `@modelcontextprotocol/sdk` 1.31.0 (MIT — © 2024 Anthropic, PBC) · `zod` 4.6.x (MIT — © 2025 Colin McDonnell) · `imagestep` (ours) |
| `imagestep-cli`       | npm      | nine runtime dependencies — §3.1                                                                                                   |
| `imagestep`           | PyPI     | `httpx` ≥ 0.27 (BSD-3-Clause — © 2019 Encode OSS Ltd) — §5.5                                                                       |

The two npm packages that redistribute nothing still carry this file, because
"nothing today" is a fact about a version, not about the package.

**How it gets there**, since a notice at the repo root is outside every package
directory and no packer would find it: `scripts/sync-notices.mjs` writes this
file into each of the five, the copies are committed the way this repo commits
its other generated artifacts, `files` (npm) and `license-files` (hatchling,
PEP 639) ship them, and `test/notices.test.js` runs the real packer and reads the
notice back out of the tarball a user would install. Editing a copy is pointless
— the test compares it byte for byte against this file. Edit this one and re-run
the script.

### 3.1 `imagestep-cli`'s runtime dependencies

Direct dependencies, on the same reading §3 applies to `@imagestep/mcp`: the CLI
bundles nothing, so npm fetches each of these because our manifest asks for it.

| Package                                                        | Version | Licence                                        |
| -------------------------------------------------------------- | ------- | ---------------------------------------------- |
| [chalk](https://github.com/chalk/chalk)                        | 6.0.1   | MIT — © Sindre Sorhus                          |
| [cli-highlight](https://github.com/felixfbecker/cli-highlight) | 2.1.11  | ISC — © 2016 Felix Frederick Becker — §5.1     |
| [cli-table3](https://github.com/cli-table/cli-table3)          | 0.6.5   | MIT — © 2014 James Talmage                     |
| [commander](https://github.com/tj/commander.js)                | 15.0.0  | MIT — © 2011 TJ Holowaychuk                    |
| [file-type](https://github.com/sindresorhus/file-type)         | 22.1.1  | MIT — © Sindre Sorhus                          |
| [js-yaml](https://github.com/nodeca/js-yaml)                   | 5.4.2   | MIT — © 2011-2015 Vitaly Puzrin                |
| [open](https://github.com/sindresorhus/open)                   | 11.0.4  | MIT — © Sindre Sorhus                          |
| [undici](https://github.com/nodejs/undici)                     | 8.11.2  | MIT — © Matteo Collina and Undici contributors |

Seven MIT rows; the body is §5.3, quoted once, and each row's copyright line is
its own.

## 4. Deliberately not here

These run **in our own containers** and are never handed to anyone. Operating
software as a network service is not distribution, so no notice condition
attaches — but the reasoning is written down because a considered omission and a
forgotten one are indistinguishable on disk.

- **`apps/service`** — Spring Boot, the PostgreSQL JDBC driver, stripe-java,
  the AWS SDK, MapStruct, Micrometer and everything else in `pom.xml`.
- **`apps/processing`** — sharp / libvips / libheif / libjxl / OpenJPEG / libraw / exiftool (and
  `exiftool-vendored`, the Node driver for its `-stay_open` protocol; the
  package's own vendored copy of exiftool is excluded at install time, see the
  root `package.json`) / `@napi-rs/image` (image-rs) / `ag-psd`. The customer receives the _output image_,
  not the codec.
- **`apps/render`** — Playwright and Chromium.
- **`apps/console`'s server half** — `pg`, `pino`, `next-auth`, `@auth/core`,
  `@auth/pg-adapter`, `shiki`. Verified absent from the client chunks, not
  assumed: greping the built bundle for `pg-pool`, `SCRAM-SHA-256`, `pino`,
  `next-auth`, `AUTH_SECRET`, `createHighlighterCoreSync`, `github-dark` and
  `createJavaScriptRegexEngine` returns zero files. `shiki` highlights every
  code block on a docs page (imagestep#321), but it does it where the page is
  rendered: `CodeBlock` is a server component, the colours are baked into the
  prerendered HTML at build time, and the browser receives coloured spans the
  way it receives a processed image and not libvips. Two of its traces do reach
  a visitor and neither is its code: the two `.shiki` rules OUR `globals.css`
  writes — which is why greping for the bare string `shiki` finds one file, a
  stylesheet — and the pair of hex values per token, taken from its bundled
  `github-light` / `github-dark` themes, output on the same reading as the line
  above.
- **`apps/public-worker`** — no runtime dependencies at all.
- **Every `devDependency`** — vitest, eslint, prettier, wrangler, esbuild. Build
  tooling is not shipped.

If any of these ever starts being handed to a user — a downloadable desktop
build, a vendored bundle, an SDK that inlines a dependency — it moves to §1 or
§3 on the same day.

## 5. Full licence texts

### 5.1 ISC License — `lucide-react`, `cli-highlight`

The body is identical for both; the copyright lines differ and are named in §1
and §3.1. Quoted here with lucide's, whose file additionally carries the Feather
attribution after the rule below — that part belongs to lucide alone,
`cli-highlight`'s file ends at the disclaimer.

```
ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

---

The following Lucide icons are derived from the Feather project:

airplay, alert-circle, alert-octagon, alert-triangle, aperture, arrow-down-circle, arrow-down-left, arrow-down-right, arrow-down, arrow-left-circle, arrow-left, arrow-right-circle, arrow-right, arrow-up-circle, arrow-up-left, arrow-up-right, arrow-up, at-sign, calendar, cast, check, chevron-down, chevron-left, chevron-right, chevron-up, chevrons-down, chevrons-left, chevrons-right, chevrons-up, circle, clipboard, clock, code, columns, command, compass, corner-down-left, corner-down-right, corner-left-down, corner-left-up, corner-right-down, corner-right-up, corner-up-left, corner-up-right, crosshair, database, divide-circle, divide-square, dollar-sign, download, external-link, feather, frown, hash, headphones, help-circle, info, italic, key, layout, life-buoy, link-2, link, loader, lock, log-in, log-out, maximize, meh, minimize, minimize-2, minus-circle, minus-square, minus, monitor, moon, more-horizontal, more-vertical, move, music, navigation-2, navigation, octagon, pause-circle, percent, plus-circle, plus-square, plus, power, radio, rss, search, server, share, shopping-bag, sidebar, smartphone, smile, square, table-2, tablet, target, terminal, trash-2, trash, triangle, tv, type, upload, x-circle, x-octagon, x-square, x, zoom-in, zoom-out

The MIT License (MIT) (for the icons listed above)

Copyright (c) 2013-present Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### 5.2 Apache License 2.0 — `class-variance-authority`

```
Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   Copyright 2022 Joe Bell

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

### 5.3 MIT License — `react`, `react-dom`, `next`, `radix-ui`, `clsx`, `tailwind-merge`, `sonner`, `next-themes`, `react-virtuoso`, `@virtuoso.dev/masonry`, `minisearch`, `fflate`, `react-hook-form`, `@hookform/resolvers`, `date-fns`, `@modelcontextprotocol/sdk`, `zod`, `chalk`, `cli-table3`, `commander`, `file-type`, `js-yaml`, `open`, `undici`

The body is identical for all twenty-four; only the copyright line differs, and each
one is named in §1, §3 and §3.1 above. Quoted here with React's, as the
representative copy.

```
MIT License

Copyright (c) Meta Platforms, Inc. and affiliates.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### 5.4 SIL Open Font License 1.1 — IBM Plex Sans, IBM Plex Mono, Literata

```
Copyright 2019 IBM Corp. All rights reserved. (IBM Plex Sans)
Copyright 2017 IBM Corp. All rights reserved. (IBM Plex Mono)
with Reserved Font Name "Plex"

Copyright 2017 The Literata Project Authors
(https://github.com/googlefonts/literata)

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```

### 5.5 BSD 3-Clause License — `httpx`

```
Copyright © 2019, [Encode OSS Ltd](https://www.encode.io/).
All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.

* Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```
