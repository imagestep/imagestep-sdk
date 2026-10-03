"""`Required` / `TypedDict` for the generated types, without a typing_extensions dependency.

`_generated.py` targets Python 3.10, where `typing.Required` does not exist yet. Its annotations
are strings (`from __future__ import annotations`) and are read by type checkers, not evaluated at
runtime, so on 3.10 without typing_extensions a placeholder is enough.
"""
import sys

if sys.version_info >= (3, 11):
    from typing import Required, TypedDict
else:  # pragma: no cover - exercised only on 3.10
    try:
        from typing_extensions import Required, TypedDict
    except ImportError:
        from typing import TypedDict

        class Required:  # placeholder, see the module docstring
            def __class_getitem__(cls, item):
                return item


__all__ = ["Required", "TypedDict"]
