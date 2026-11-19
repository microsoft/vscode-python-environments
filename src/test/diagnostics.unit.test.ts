import assert from 'node:assert';
import fs from 'fs';
import * as path from 'path';
import * as sinon from 'sinon';
import { version } from 'vscode';
import { mochaGlobalSetup } from './diagnostics';

suite('Test runner diagnostics', () => {
    let write: sinon.SinonStub;
    const directory = path.resolve('test diagnostics');

    setup(() => {
        sinon.stub(process, 'env').value({ ...process.env, VSCODE_TEST_DIAGNOSTICS_DIR: directory });
        write = sinon.stub(fs, 'writeFileSync');
    });

    teardown(() => sinon.restore());

    test('records the test-runner marker and runtime details', () => {
        mochaGlobalSetup();

        sinon.assert.calledOnceWithExactly(
            write,
            path.join(directory, 'test-runner-started.json'),
            JSON.stringify({ vscodeVersion: version, extensionHostArgs: process.argv }, undefined, 2),
        );
    });

    test('does not write diagnostics when disabled', () => {
        delete process.env.VSCODE_TEST_DIAGNOSTICS_DIR;

        mochaGlobalSetup();

        sinon.assert.notCalled(write);
    });

    test('does not hide diagnostic write failures', () => {
        const error = new Error('Cannot write diagnostics');
        write.throws(error);

        assert.throws(() => mochaGlobalSetup(), (actual) => actual === error);
    });
});
