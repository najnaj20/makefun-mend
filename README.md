# makefun-mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/najnaj20/makefun-mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/najnaj20/makefun-mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one patch tool for every edit format an AI model writes: unified diffs (even with wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and JSON edit calls. It finds the lines each edit names at the first of three matching tiers (exact, trailing whitespace, then indentation), applies every edit or none at all, and prints exactly what it changed or why it failed. It handles CRLF files, files with no final line break, creates, deletes and moves, and runs with `--check` to preview a patch without writing anything.

## Run it

```sh
node main.ts patch.diff
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=0c4qjdq4&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
