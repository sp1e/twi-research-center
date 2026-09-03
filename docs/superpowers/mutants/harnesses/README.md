# Mutation harnesses

The scripts that actually applied the mutants recorded in `../twi-creation-core.mutants.json`.

They are committed because the manifest's own `uncertainty.harnessesNotCommitted` said they
were not, and a mutation score nobody can reproduce is a claim, not evidence. Each resolves
the repository root from its own location, so they run from any checkout on any machine:

```
python docs/superpowers/mutants/harnesses/task9_mutants.py
python docs/superpowers/mutants/harnesses/guards_mutants.py
python docs/superpowers/mutants/harnesses/task10_finish_mutants.py
```

| Harness | Round | Result |
|---|---|---|
| `task9_mutants.py` | Lyria adapter, WAV reader, provider selection | 17/17 killed at `9377337` |
| `task8_publication_mutants.py` | publication invariants, INLINE, first pass | **9 of 12 SURVIVED** at `9377337` |
| `guards_mutants.py` | the same invariants after extraction | 20/20 killed at `db289a1` |
| `task10_finish_mutants.py` | finishing rules in `stems-gpu/finish.py` | 12/12 killed at `ce2c775` |
| `task11_finishing_mutants.py` | the Modal finishing seam in `twi-orchestrator/` | 14/14 killed on the Task 11 branch tip |
| `provider_call_state_mutants.py` | provider-call state (research P0): schema pairing, claim/settle/resolve, the step body's order, the retry gate, the migration consumers | 20/20 killed at `cd87b87`; PCS-14 died ONLY in the contract check, by design |

`task8_publication_mutants.py` reports `NEEDLE-MISSING` at HEAD **by design** — the code it
mutates was extracted into `publication-guards.ts`. To reproduce its finding, check out
`9377337` first. It is kept because the nine survivors are the most useful result in this
directory: they are why the guards were extracted at all.

## Rules every harness here follows

- **Restore in `finally`, then verify.** A campaign that crashes mid-mutation leaves live code
  mutated. That happened once on this project (a Windows charmap decode error killed the
  script after applying a mutant and before restoring it), and was caught only by comparing
  sha256 against the pre-campaign baseline. Every harness now asserts the hash on the way out.
- **Verify the edit LANDED.** A mutation that fails to apply is indistinguishable from one
  that got killed. `NEEDLE-MISSING` and `APPLY-FAIL` are reported separately from `SURVIVED`.
- **Name the killer.** "The suite went red" is weaker evidence than "this named test went red";
  `guards_mutants.py` prints JSON so the names can be read back rather than retyped.
- **`encoding="utf-8", errors="replace"`** on every `subprocess.run`. Windows defaults to
  cp1252 and will raise `UnicodeDecodeError` on ffmpeg or vitest output.
