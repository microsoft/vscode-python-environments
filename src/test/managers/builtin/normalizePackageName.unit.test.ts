import assert from 'assert';
import { normalizePackageName } from '../../../managers/builtin/utils';

suite('normalizePackageName', () => {
    test('should lowercase names', () => {
        assert.strictEqual(normalizePackageName('Requests'), 'requests');
        assert.strictEqual(normalizePackageName('NUMPY'), 'numpy');
    });

    test('should replace underscores with hyphens', () => {
        assert.strictEqual(normalizePackageName('my_package'), 'my-package');
    });

    test('should replace dots with hyphens', () => {
        assert.strictEqual(normalizePackageName('zope.interface'), 'zope-interface');
    });

    test('should collapse consecutive separators into a single hyphen', () => {
        assert.strictEqual(normalizePackageName('my__package'), 'my-package');
        assert.strictEqual(normalizePackageName('my_-package'), 'my-package');
        assert.strictEqual(normalizePackageName('my_.package'), 'my-package');
    });

    test('should handle mixed separators and casing', () => {
        assert.strictEqual(normalizePackageName('My_Package.Name'), 'my-package-name');
        assert.strictEqual(normalizePackageName('Foo-Bar_Baz'), 'foo-bar-baz');
    });

    test('should return already-normalized names unchanged', () => {
        assert.strictEqual(normalizePackageName('requests'), 'requests');
        assert.strictEqual(normalizePackageName('my-package'), 'my-package');
    });

    test('should handle single-word names', () => {
        assert.strictEqual(normalizePackageName('pip'), 'pip');
    });

    test('should produce equal results for equivalent package names', () => {
        const variants = ['My_Package', 'my-package', 'my.package', 'My.Package', 'MY_PACKAGE', 'my_package'];
        const normalized = variants.map(normalizePackageName);
        assert.ok(
            normalized.every((n) => n === normalized[0]),
            `All variants should normalize to the same value, got: ${JSON.stringify(normalized)}`,
        );
    });
});
