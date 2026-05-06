"""Adapter for the local saros-geo copy."""

from __future__ import annotations

from functools import lru_cache
import importlib.util
from pathlib import Path
from types import ModuleType
from typing import Any


PYTHON_ROOT = Path(__file__).resolve().parent.parent
SAROS_GEO_DIR = PYTHON_ROOT / "saros-geo"
DEFAULT_DATA_DIR = SAROS_GEO_DIR / "data"


@lru_cache(maxsize=1)
def _saros_geo_module() -> ModuleType:
    path = SAROS_GEO_DIR / "saros_geo.py"
    if not path.exists():
        raise FileNotFoundError(f"saros_geo.py not found at {path}")
    spec = importlib.util.spec_from_file_location("qscsvg_saros_geo", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load saros_geo.py from {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@lru_cache(maxsize=256)
def load_saros(saros_number: int, data_dir: str | Path | None = None) -> list[dict[str, Any]]:
    directory = Path(data_dir) if data_dir is not None else DEFAULT_DATA_DIR
    path = directory / f"{int(saros_number)}.bin"
    if not path.exists():
        raise FileNotFoundError(f"saros data not found: {path}")
    return _saros_geo_module().decode_series(path.read_bytes())


def get_eclipse(
    saros_number: int,
    position: int,
    data_dir: str | Path | None = None,
) -> dict[str, Any]:
    records = load_saros(int(saros_number), Path(data_dir) if data_dir is not None else None)
    try:
        return records[int(position)]
    except IndexError as exc:
        raise IndexError(f"saros {saros_number} has no eclipse at position {position}") from exc
