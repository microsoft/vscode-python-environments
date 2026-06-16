import assert from 'assert';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as sinon from 'sinon';
import { LogOutputChannel } from 'vscode';
import { parsePipListJson, parseUvTree } from '../../../managers/builtin/pipListUtils';
import { EXTENSION_TEST_ROOT } from '../../constants';

const TEST_DATA_ROOT = path.join(EXTENSION_TEST_ROOT, 'managers', 'builtin');

suite('Pip List JSON Parser tests', () => {
    let log: LogOutputChannel;

    setup(() => {
        log = {
            error: sinon.stub(),
            warn: sinon.stub(),
            info: sinon.stub(),
        } as unknown as LogOutputChannel;
    });

    teardown(() => {
        sinon.restore();
    });

    const testNames = ['piplist1', 'piplist2', 'piplist3'];

    testNames.forEach((testName) => {
        test(`Test parsing pip list JSON output ${testName}`, async () => {
            const expected = JSON.parse(
                await fs.readFile(path.join(TEST_DATA_ROOT, `${testName}.expected.json`), 'utf8'),
            );
            const pipListOutput = JSON.stringify(expected.packages);

            const actualPackages = parsePipListJson(pipListOutput, log);

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
        assert.deepStrictEqual(parsePipListJson('not json', log), []);
    });

    test('Logs error when JSON parsing fails', () => {
        parsePipListJson('not valid json', log);
        assert.ok((log.error as sinon.SinonStub).calledOnce, 'Expected error to be logged');
    });

    test('Returns empty array without logging when no log is provided', () => {
        const result = parsePipListJson('not valid json');
        assert.deepStrictEqual(result, []);
    });

    test('Skips items without a name or version', () => {
        const actualPackages = parsePipListJson(
            JSON.stringify([{ name: 'pip', version: '24.0' }, { name: 'setuptools' }, { version: '1.0.0' }]),
            log,
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

    test('Returns empty array for non-array JSON', () => {
        const result = parsePipListJson('{"name": "pip"}', log);
        assert.deepStrictEqual(result, []);
    });

    test('Returns empty array for empty array JSON', () => {
        const result = parsePipListJson('[]', log);
        assert.deepStrictEqual(result, []);
    });
});

suite('parseUvTree tests', () => {
    test('Parses uv pip tree output with depth 0', () => {
        const input = 'requests v2.31.0\nflask v3.0.0\n';
        const result = parseUvTree(input);
        assert.deepStrictEqual(result, ['requests', 'flask']);
    });

    test('Handles empty output', () => {
        assert.deepStrictEqual(parseUvTree(''), []);
    });

    test('Filters blank lines', () => {
        const input = 'requests v2.31.0\n\n\nflask v3.0.0\n';
        const result = parseUvTree(input);
        assert.deepStrictEqual(result, ['requests', 'flask']);
    });

    test('Handles single package', () => {
        const input = 'pip v24.0\n';
        const result = parseUvTree(input);
        assert.deepStrictEqual(result, ['pip']);
    });

    test('Trims leading whitespace from indented lines', () => {
        const input = '  requests v2.31.0\n  flask v3.0.0\n';
        const result = parseUvTree(input);
        assert.deepStrictEqual(result, ['requests', 'flask']);
    });
});
