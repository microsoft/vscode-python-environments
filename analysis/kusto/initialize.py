# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.

"""Kusto authentication for the telemetry dashboard.

Prerequisites:
    1. Install: pip install azure-kusto-data
    2. Authenticate: az login
"""

import shutil

from azure.kusto.data import KustoClient, KustoConnectionStringBuilder

CLUSTER = "ddtelvscode.kusto.windows.net"
DATABASE = "VSCodeExt"


def initialize(cluster: str = CLUSTER) -> KustoClient:
    """Return an authenticated KustoClient.

    Uses Azure CLI authentication if ``az`` is on PATH, otherwise falls back
    to interactive browser login.
    """
    url = f"https://{cluster}"
    if shutil.which("az"):
        return KustoClient(KustoConnectionStringBuilder.with_az_cli_authentication(url))
    return KustoClient(KustoConnectionStringBuilder.with_interactive_login(url))
