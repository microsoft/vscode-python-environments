import assert from 'node:assert';
import { isPoetryVirtualenvsInProject } from '../../../managers/poetry/poetryUtils';

suite('isPoetryVirtualenvsInProject', () => {
    let originalEnv: string | undefined;

    setup(() => {
        originalEnv = process.env.POETRY_VIRTUALENVS_IN_PROJECT;
    });

    teardown(() => {
        if (originalEnv === undefined) {
            delete process.env.POETRY_VIRTUALENVS_IN_PROJECT;
        } else {
            process.env.POETRY_VIRTUALENVS_IN_PROJECT = originalEnv;
        }
    });

    test('should return false when env var is not set', () => {
        delete process.env.POETRY_VIRTUALENVS_IN_PROJECT;
        assert.strictEqual(isPoetryVirtualenvsInProject(), false);
    });

    test('should return true when env var is "true"', () => {
        process.env.POETRY_VIRTUALENVS_IN_PROJECT = 'true';
        assert.strictEqual(isPoetryVirtualenvsInProject(), true);
    });

    test('should return true when env var is "True" (case insensitive)', () => {
        process.env.POETRY_VIRTUALENVS_IN_PROJECT = 'True';
        assert.strictEqual(isPoetryVirtualenvsInProject(), true);
    });

    test('should return true when env var is "TRUE" (case insensitive)', () => {
        process.env.POETRY_VIRTUALENVS_IN_PROJECT = 'TRUE';
        assert.strictEqual(isPoetryVirtualenvsInProject(), true);
    });

    test('should return true when env var is "1"', () => {
        process.env.POETRY_VIRTUALENVS_IN_PROJECT = '1';
        assert.strictEqual(isPoetryVirtualenvsInProject(), true);
    });

    test('should return false when env var is "false"', () => {
        process.env.POETRY_VIRTUALENVS_IN_PROJECT = 'false';
        assert.strictEqual(isPoetryVirtualenvsInProject(), false);
    });

    test('should return false when env var is "0"', () => {
        process.env.POETRY_VIRTUALENVS_IN_PROJECT = '0';
        assert.strictEqual(isPoetryVirtualenvsInProject(), false);
    });

    test('should return false when env var is empty string', () => {
        process.env.POETRY_VIRTUALENVS_IN_PROJECT = '';
        assert.strictEqual(isPoetryVirtualenvsInProject(), false);
    });

    test('should return false when env var is arbitrary string', () => {
        process.env.POETRY_VIRTUALENVS_IN_PROJECT = 'yes';
        assert.strictEqual(isPoetryVirtualenvsInProject(), false);
    });
});
