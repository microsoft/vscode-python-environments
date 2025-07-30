import * as os from 'os';
import * as path from 'path';

/**
 * Returns an array of possible sh profile paths in order of preference.
 */
export async function getShProfiles(): Promise<string> {
    const home = os.homedir();
    return path.join(home, '.profile');
}
