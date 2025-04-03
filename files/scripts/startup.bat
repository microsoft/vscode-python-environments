if "%TERM_PROGRAM%"=="vscode" (
    if not defined VSCODE_PYTHON_AUTOACTIVATE_GUARD (
        set "VSCODE_PYTHON_AUTOACTIVATE_GUARD=1"
        if defined VSCODE_CMD_ACTIVATE (
            call %VSCODE_CMD_ACTIVATE%
        )
    )
)