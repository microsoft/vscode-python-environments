export async function sleep(milliseconds: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

export function timeout(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// TODO: Advanced timeout from core async: https://github.com/microsoft/vscode-python-environments/issues/953
