[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/jakiww/site-generator-speed/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/jakiww/site-generator-speed/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

# site-generator-speed

A faster drop-in for makefun-site 1.0.0: builds the same static sites and answers exactly as makefun-site does on every case, in less CPU time.

## What it does

`solve.js` exports `run(input)`, which builds one case's site `{ site, templates, files }` into the output tree makefun-site 1.0.0 returns — every page's `index.html`, the index and tag pages, `build-report.txt` and each static file, byte for byte: the same front matter refusals, the same slug rule with the same collision suffixes, the same Markdown subset, the same template dialect, the same link resolution and broken-link report.

`main.ts` is the program the harness runs: it reads every case from `/input/cases.json`, answers each one with `run`, and writes `/output/answers.json`.

## How it is fast

makefun-site renders Markdown one character at a time, escaping each character through a regex, and walks every template node by node on every page. This build does none of that:

- Inline Markdown scans plain runs in bulk: a regex finds the next special character and the run between specials is sliced at once.
- Blocks lex and render in one pass, so no token objects are ever built.
- Front matter walks lines by index instead of splitting the whole source.
- Slugs are memoised per build, and each page's card is built once, not twice.
- Every template is compiled once per build to a plain function, and includes of a template whose inputs are already known (a card, a header, a footer) are memoised on those inputs — rendered once per build, reused wherever the same inputs recur.

Nothing is cached from one case to the next: every cache lives inside one `run()` call.

## Measured

On the kit's practice set (3 cases, 250–480 sources each), `run()` takes a median **145 ms CPU** against the house baseline's **575 ms** — about **4.0× faster**. On 15 extra sets drawn from the kit's generator with random seeds, 45/45 cases were byte-identical to makefun-site, at 2.7–4.3× the baseline's speed. `grade-local` on the practice set: 3/3 cases identical, passed.
