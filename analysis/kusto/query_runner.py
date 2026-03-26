# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.

"""Load and execute .kql files against Azure Data Explorer.

Keeps the existing .kql files as the single source of truth — they can still
be copy-pasted into the ADX web UI, AND this module can run them from Python.
"""

import pathlib
import re
from typing import List, Tuple

import pandas as pd
from azure.kusto.data import KustoClient
from azure.kusto.data.helpers import dataframe_from_result_table

KQL_DIR = pathlib.Path(__file__).parent
DATABASE = "VSCodeExt"

# Separator pattern used in multi-query files like 00-prerelease-telemetry-validation.kql
_SECTION_SEP = re.compile(r"^// =====+", re.MULTILINE)


def load_kql(filename: str) -> str:
    """Read a .kql file and strip leading comment-only lines."""
    path = KQL_DIR / filename
    lines = path.read_text(encoding="utf-8").splitlines()
    return "\n".join(line for line in lines if not line.strip().startswith("//"))


def load_kql_sections(filename: str) -> List[Tuple[str, str]]:
    """Split a multi-query .kql file into ``(title, query)`` pairs.

    Sections are delimited by ``// ====...====`` separator lines.  The first
    comment line after a separator is used as the section title.
    """
    text = (KQL_DIR / filename).read_text(encoding="utf-8")
    raw_sections = _SECTION_SEP.split(text)

    # Each section is either a "header" (comments only) or a "body" (has KQL).
    # Headers set the title for the next body section.
    results: List[Tuple[str, str]] = []
    pending_title: str = ""
    for section in raw_sections:
        lines = section.strip().splitlines()
        if not lines:
            continue
        comment_lines = [
            ln.lstrip("/ ").strip() for ln in lines if ln.strip().startswith("//")
        ]
        query_lines = [
            ln for ln in lines if not ln.strip().startswith("//") and ln.strip()
        ]
        if query_lines:
            title = pending_title or (comment_lines[0] if comment_lines else "Untitled")
            results.append((title, "\n".join(query_lines)))
            pending_title = ""
        elif comment_lines:
            # Comment-only section — use first line as the title for the next query
            pending_title = comment_lines[0]
    return results


def run_kql(
    client: KustoClient, query: str, database: str = DATABASE
) -> pd.DataFrame:
    """Execute a KQL query string and return results as a DataFrame."""
    response = client.execute(database, query)
    return dataframe_from_result_table(response.primary_results[0])


def run_kql_file(
    client: KustoClient, filename: str, database: str = DATABASE
) -> pd.DataFrame:
    """Load a .kql file and execute it."""
    return run_kql(client, load_kql(filename), database)
