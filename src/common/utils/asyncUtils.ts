export async function timeout(milliseconds: number): Promise<void> {
    return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

// TODO: Advanced timeout from core async: https://github.com/microsoft/vscode-python-environments/issues/953
