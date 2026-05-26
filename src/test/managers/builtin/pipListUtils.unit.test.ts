import assert from 'assert';
import * as fs from 'fs-extra';
import * as path from 'path';
import { parsePipListJson } from '../../../managers/builtin/pipListUtils';
import { EXTENSION_TEST_ROOT } from '../../constants';

const TEST_DATA_ROOT = path.join(EXTENSION_TEST_ROOT, 'managers', 'builtin');

suite('Pip List JSON Parser tests', () => {
    const testNames = ['piplist1', 'piplist2', 'piplist3'];

    testNames.forEach((testName) => {
        test(`Test parsing pip list JSON output ${testName}`, async () => {
            const expected = JSON.parse(
                await fs.readFile(path.join(TEST_DATA_ROOT, `${testName}.expected.json`), 'utf8'),
            );
            const pipListOutput = JSON.stringify(expected.packages);

            const actualPackages = parsePipListJson(pipListOutput);

            assert.equal(actualPackages.length, expected.packages.length, 'Unexpected number of packages');
            actualPackages.forEach((actualPackage) => {
                const expectedPackage = expected.packages.find(
                    (item: { name: string }) => item.name === actualPackage.name,
                );
                assert.ok(expectedPackage, `Package ${actualPackage.name} not found in expected packages`);
                assert.equal(actualPackage.version, expectedPackage.version, 'Version mismatch');
            });

            expected.packages.forEach((expectedPackage: { name: string; version: string }) => {
                const actualPackage = actualPackages.find((item) => item.name === expectedPackage.name);
                assert.ok(actualPackage, `Package ${expectedPackage.name} not found in actual packages`);
                assert.equal(actualPackage.version, expectedPackage.version, 'Version mismatch');
            });
        });
    });

    test('Returns an empty array for invalid JSON input', () => {
        assert.deepStrictEqual(parsePipListJson('not json'), []);
    });

    test('Skips items without a name or version', () => {
        const actualPackages = parsePipListJson(
            JSON.stringify([{ name: 'pip', version: '24.0' }, { name: 'setuptools' }, { version: '1.0.0' }]),
        );

        assert.deepStrictEqual(actualPackages, [
            {
                name: 'pip',
                version: '24.0',
                displayName: 'pip',
                description: '24.0',
            },
        ]);
    });
});
