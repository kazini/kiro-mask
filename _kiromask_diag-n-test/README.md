# _kiromask_diag-n-test

Extra tools for capturing Kiro's traffic, diagnosing problems and testing kiromask. It isn't needed to run kiromask, so you can delete the folder, and will be left out of packaged releases. `capture` and `doctor` work on their own; the tests also apply to the main `_kiromask-src`.

Needs Node 18.18 or newer. Close Kiro before running any of these.

```
node capture.mjs       # opens Kiro behind a recording proxy; use it, close it, get a .tar.gz in output/
node doctor.mjs        # checks your system, your Kiro install and the proxy, also leaves a .tar.gz in output/
node run-tests.mjs     # all the tests (--skip-diag to skip the slow ones)
```

If Kiro isn't found, pass `--exe <path to Kiro.exe or its folder>`.

The archives hide tokens and cookies, but your prompts and code are in the captures, so look before sending them to anyone. Tokens tend to be temporary and cycle, so it shouldn't be a *monumental catastrophe*.

`network-protocol-notes.md` has what's known about the messages Kiro sends and expects, documented by an agentic LLM. Tests that need real recorded traffic read it from the folder in `KIROMASK_CAPTURES`, and skip if it isn't set.

`lib/` is shared code, `tests/` the tests, `checks/` standalone check scripts and `py/` has a few python cross-checks.
