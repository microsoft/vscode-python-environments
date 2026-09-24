// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import * as platformUtils from '../../common/utils/platformUtils';
import { getVenvPythonPath } from '../../common/utils/virtualEnvironment';

suite('virtual environment utilities', () => {
    teardown(() => {
        sinon.restore();
    });

    test('uses Scripts/python.exe on Windows', () => {
        sinon.stub(platformUtils, 'isWindows').returns(true);
        assert.strictEqual(
            getVenvPythonPath(path.join('cache', 'env')),
            path.join('cache', 'env', 'Scripts', 'python.exe'),
        );
    });

    test('uses bin/python outside Windows', () => {
        sinon.stub(platformUtils, 'isWindows').returns(false);
        assert.strictEqual(getVenvPythonPath(path.join('cache', 'env')), path.join('cache', 'env', 'bin', 'python'));
    });
});
