import which from 'which';

/**
 * Checks if an executable exists in the system PATH.
 * @param executable The name or path of the executable to check.
 * @returns A promise that resolves to true if the executable exists, false otherwise.
 */
export async function executableExists(executable: string): Promise<boolean> {
    try {
        await which(executable);
        return true;
    } catch (_err) {
        return false;
    }
}