# Synthetic readiness classifier

1,000 fictional workers, with three **simulated** labels:

| Label | Intended planning meaning |
|---|---|
| beginner | Foundational training and a slow starting ramp |
| okay | Some transferable experience; a reduced package plus targeted modules |
| expert | Strong relevant experience; a faster ramp after required checks |

These meanings are a proposed rubric for the current delivery-worker questionnaire. They are not a general model of employee ability or a package-handler assessment. “Half the package” is not a measured 50% allocation, and none of the labels waives mandatory training, licensing or safety checks. The manager approves any real plan.

Synthetic data exercises feature handling, training, serialization and inference. Scores measure how well a model learns the simulator's assumptions. They do **not** demonstrate real employee readiness or establish how much training a worker needs. Increasing the synthetic row count does not resolve this limitation.

## Run locally

This is a separate Python experiment alongside the existing Node application. It does not modify the app, read its database, call an LLM, or change the current two-track policy.

From the repository root:

```sh
cd ml
uv sync --python 3.12
uv run python -m unittest discover -p 'test_*.py'
uv run python synthetic.py --rows 1000 --seed 42
uv run python train.py --seed 42
uv run python predict.py artifacts/snapshots.jsonl --model catboost
```

CatBoost is the default and the deployed classifier. For optional XGBoost comparison:

```sh
uv sync --extra xgboost
uv run --extra xgboost python train.py --models both
uv run --extra xgboost python predict.py artifacts/snapshots.jsonl --model xgboost
```

Python 3.12 or 3.13 is supported. `uv.lock` records the dependencies. On macOS, XGBoost also needs the OpenMP runtime (`brew install libomp`). Both models train on CPU with four threads; this small dataset does not need a GPU. The integrated application runs training and inference on the GB10. See [the planning and installation contract](../docs/READINESS.md). Dependency installation downloads packages.

`artifacts/` contains:

| File | Contents |
|---|---|
| questionnaire.csv | 1,000 flattened feature rows, identifiers and labels |
| snapshots.jsonl | Matching questionnaire/CV snapshots in the current app's `{asked, cv}` format |
| dataset.json | Generator version, seed, row count and label counts |
| split.json | Case IDs for train, validation and test partitions |
| report.json | Baseline, per-class precision/recall/F1, confusion matrices, log loss, feature importance and dependency versions |
| catboost.cbm / xgboost.json | Saved models, with probability agreement checked after reload |
| *-manifest.json | Artifact/preprocessing checksums, feature order and class order |
| *-test-predictions.csv | Held-out labels and probabilities for each model |

Generated files and the virtual environment are ignored by Git. Re-running a command replaces its output files in the chosen directory. Use `--out artifacts/another-run` to keep another experiment; `train.py --data ... --out ...` can select it.

## Features and simulation

The pasted schema is explicitly a brainstorm. This experiment uses the fields actually implemented in `src/engine/slack-questionnaire.ts` and `src/engine/features.ts`:

- Parcel, other delivery and warehouse years from available CV/questionnaire facts.
- License category, largest vehicle, route type, equipment, delivery app experience and area familiarity.
- The current three self-ratings: navigation, scanning/proof of delivery and customer handoff.
- Whether each field was asked, whether its value is known, and its source. CV confirmation is marked separately.

Numeric unknowns remain NaN; categorical unknowns use `__unknown__`. A complete equipment answer of `[]` means no listed equipment. A CV listing one tool does not imply no experience with the remaining tools. An answer about other delivery does not imply zero parcel experience. Partial rating blocks retain missing ratings. Invalid values fail validation.

An explicit allowlist excludes name, email, language, shift preference, raw text, home location, identity attributes, plan track/modules, manager overrides and later outcomes. Area familiarity refers to familiarity with the depot's route area; depot identity itself is excluded. The future brainstorm fields (stops/day, recency, extra ratings, etc.) are not fabricated as if the app already collected them. The current snapshot format does not retain a separate declined status or extraction confidence; those require a future app schema change.

The generator samples three overlapping experience archetypes, a continuous latent skill, correlated work history/tool exposure, and noisy self-confidence. A simulated readiness score combines latent skill, app exposure and independent noise; thresholds 0.36 and 0.70 assign labels. These numbers and distributions are design assumptions, not company policy or empirical findings. Missing responses occur independently at 7%; CV coverage and question selection vary with recorded experience. The data includes cautious experienced workers, overconfident beginners and experienced workers unfamiliar with a new depot. No label, latent skill or readiness score enters the feature matrix.

Training uses one fixed, stratified **700/150/150** train/validation/test split for 1,000 rows. Validation controls early stopping and the preferred-model comparison; test data stays out of fitting. A prior-frequency baseline gives context. Duplicate case IDs are rejected so one worker cannot appear in multiple partitions. CatBoost receives native categorical features; XGBoost uses native categorical features with a fixed category vocabulary. Both handle numeric missingness directly. Probabilities are uncalibrated, and missing evidence needs manager review even when a model returns a confident class.

Implementation references: [CatBoost categorical features](https://catboost.ai/docs/en/features/categorical-features), [CatBoost missing values](https://catboost.ai/docs/en/concepts/algorithm-missing-values-processing), [XGBoost categorical features](https://xgboost.readthedocs.io/en/stable/tutorials/categorical.html).

## Replacing simulation with evidence

Define a role-specific rubric with managers and mentors before collecting labels. Label initial readiness from an independent practical assessment; later ramp/module outcomes can provide validation, but they also reflect the training provided. Training track assignment alone would reproduce the existing policy rather than measure capability.

Freeze each worker's features before the assessment being predicted, attach labels separately, and keep every version of a worker in the same partition. The app now requires a confirmed questionnaire snapshot before proposing a plan. Evaluate on held-out real workers, preferably a later cohort, and measure per-class errors and probability calibration. Keep synthetic and real evaluation results separate. The integrated demo uses predictions for manager-approved policy tiers; use advisory mode for real workers until validation is complete.
