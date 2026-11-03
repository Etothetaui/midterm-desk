"""Coordinated existing-source publication, reachable through update_results CLI.

Official AZ/NC counts and methods share one fetch; optional historical publisher
diagnostics cannot prevent other sources updating. Analysis refresh retains its
same-candidate last-good artifact and publishes health separately. No call or
vote is inferred by this orchestration layer.
"""

import argparse
import json
from pathlib import Path
import subprocess
import sys
import tempfile

import update_results as shared
from update_vote_methods import update_vote_methods, validate_vote_methods
from update_national_results import update_national, validate_national_records
from update_analysis import usable_previous


ROOT = Path(__file__).resolve().parent


def run_pipeline(snapshot, loader=shared.fetch, *, checked_at=None, reviewed_revisions=None,
                 include_diagnostic=True, analysis_refresher=None, ap_refresher=None):
    """Injected loaders/analysis callback make ordering and failures testable."""
    checked_at = checked_at or shared.instant()
    output = update_vote_methods(snapshot, loader, checked_at, reviewed_revisions,
                                 ["az-official", "nc-official"])
    if include_diagnostic:
        output = shared.update(output, ["deepsyte-results"], loader, checked_at, reviewed_revisions)
    output = update_national(output, loader, checked_at, reviewed_revisions)
    validate_vote_methods(output)
    validate_national_records(output)
    if ap_refresher is not None:
        output = ap_refresher(output)
    if analysis_refresher is not None:
        analysis_refresher(output)
    return output


def refresh_ap(snapshot, *, runner=subprocess.run):
    """Shared browser/Node AP parser; an AP failure cannot erase other sources.

    Only the AP envelope may change. This prevents an optional public-post
    monitor from replacing already validated counts, candidates or forecasts.
    """
    try:
        with tempfile.TemporaryDirectory(prefix='midterm-ap-') as directory:
            source, target = Path(directory) / 'input.json', Path(directory) / 'output.json'
            shared.atomic_write(source, snapshot)
            run = runner(['node', str(ROOT / 'update_ap_source.mjs'), str(source), str(target)],
                         capture_output=True, text=True, encoding='utf-8', timeout=75)
            if run.returncode != 0 or not target.exists():
                raise shared.InvalidResults('AP monitor process did not return a snapshot')
            result = json.loads(target.read_text(encoding='utf-8-sig'))
            prior_fields = {k: v for k, v in snapshot.items() if k != 'apPublicSource'}
            next_fields = {k: v for k, v in result.items() if k != 'apPublicSource'}
            if next_fields != prior_fields or not isinstance(result.get('apPublicSource'), dict):
                raise shared.InvalidResults('AP monitor attempted to change another source')
            return result
    except Exception:
        # The browser can still check AP directly; preserve every prior source
        # and expose the last supported AP observations with a failed check.
        result = dict(snapshot)
        if isinstance(snapshot.get('apPublicSource'), dict):
            result['apPublicSource'] = {**snapshot['apPublicSource'],
                'status': 'retained-error' if snapshot['apPublicSource'].get('observations') else 'error',
                'checkedAt': shared.instant(), 'errorCode': 'publication-monitor-failed', 'retryAfterAt': None}
        return result


def refresh_analysis(snapshot, analysis_path, health_path, *, runner=subprocess.run, seed_path=None):
    """Same normalization/health policy as refresh_analysis.py, staged catalog.

    update_analysis has a guarded main; refresh_analysis.py itself does not and
    must not be imported. A probe seeds a separate copy, never root analytics.
    """
    analysis_path, health_path = Path(analysis_path), Path(health_path)
    analysis_path.parent.mkdir(parents=True, exist_ok=True)
    if not analysis_path.exists() and seed_path is not None and Path(seed_path).exists():
        analysis_path.write_bytes(Path(seed_path).read_bytes())
    previous_bytes = analysis_path.read_bytes() if analysis_path.exists() else None
    try:
        previous = json.loads(previous_bytes.decode("utf-8-sig")) if previous_bytes else None
    except (ValueError, UnicodeDecodeError):
        previous = None
    retained = previous is not None and usable_previous(previous, snapshot)
    health = None
    try:
        with tempfile.TemporaryDirectory(prefix="midterm-pipeline-", dir=analysis_path.parent) as directory:
            cache = Path(directory)
            catalog_path = cache / "catalog.json"
            shared.atomic_write(catalog_path, snapshot)
            run = runner([sys.executable, str(ROOT / "update_analysis.py"), "--source-dir", str(cache / "downloads"),
                          "--catalog", str(catalog_path), "--output", str(analysis_path), "--fetch", "--allow-stale"],
                         capture_output=True, text=True, encoding="utf-8", timeout=180)
        result = None
        for line in reversed((run.stdout or "").splitlines() + (run.stderr or "").splitlines()):
            try:
                candidate = json.loads(line)
            except ValueError:
                continue
            if isinstance(candidate, dict) and isinstance(candidate.get("updateHealth"), dict):
                result = candidate
                break
        if result is None:
            raise shared.InvalidResults("Analysis updater supplied no valid health record")
        health = result["updateHealth"]
        if health.get("status") == "ready" and run.returncode == 0:
            if not analysis_path.exists() or not usable_previous(json.loads(analysis_path.read_text(encoding="utf-8-sig")), snapshot):
                raise shared.InvalidResults("Refreshed analysis does not match the staged candidate catalog")
        elif health.get("status") == "retained" and retained:
            if previous_bytes is not None:
                analysis_path.write_bytes(previous_bytes)
        else:
            raise shared.InvalidResults(str(result.get("error") or health.get("error") or "Analysis refresh failed"))
    except Exception as error:
        if previous_bytes is not None:
            analysis_path.write_bytes(previous_bytes)
        health = {"status": "retained" if retained else "error", "checkedAt": shared.instant(), "error": str(error),
                  "message": "Refresh failed; last-good artifact retained." if retained else "No usable same-candidate analysis artifact."}
    shared.atomic_write(health_path, health)
    if health["status"] == "error":
        raise shared.InvalidResults(health["error"])
    return health


def run_cli_pipeline(snapshot, target, *, input_path=None, probe=False, reviewed_revisions=None,
                     loader=shared.fetch, analysis_runner=subprocess.run, include_diagnostic=True):
    target = Path(target)
    if probe:
        analysis_path = target.with_name(target.name + ".analysis.json")
        health_path = target.with_name(target.name + ".analysis-health.json")
        protected = {path.resolve() for path in [ROOT / "data.json", ROOT / "analysis.json", ROOT / "analysis-health.json"]}
        if input_path is not None:
            protected.add(Path(input_path).resolve())
        if any(path.resolve() in protected for path in (target, analysis_path, health_path)):
            raise shared.InvalidResults("Probe outputs must not overwrite input or public source artifacts")
    else:
        analysis_path, health_path = ROOT / "analysis.json", ROOT / "analysis-health.json"
    return run_pipeline(snapshot, loader, reviewed_revisions=reviewed_revisions, include_diagnostic=include_diagnostic,
                        ap_refresher=refresh_ap,
                        analysis_refresher=lambda result: refresh_analysis(result, analysis_path, health_path,
                            runner=analysis_runner, seed_path=ROOT / "analysis.json" if probe else None))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=ROOT / "data.json")
    destination = parser.add_mutually_exclusive_group(required=True)
    destination.add_argument("--output", type=Path)
    destination.add_argument("--probe", type=Path)
    parser.add_argument("--reviewed-revisions", type=Path)
    parser.add_argument("--skip-diagnostic", action="store_true")
    args = parser.parse_args()
    target = args.probe or args.output
    if args.probe and target.resolve() == args.input.resolve():
        parser.error("Probe destination must differ from input snapshot")
    snapshot = json.loads(args.input.read_text(encoding="utf-8-sig"))
    reviews = json.loads(args.reviewed_revisions.read_text(encoding="utf-8-sig")) if args.reviewed_revisions else None
    result = run_cli_pipeline(snapshot, target, input_path=args.input, probe=bool(args.probe), reviewed_revisions=reviews,
                              include_diagnostic=not args.skip_diagnostic)
    shared.atomic_write(target, result)
    print(json.dumps({"snapshotId": result["snapshotId"], "output": str(target)}))


if __name__ == "__main__":
    main()
