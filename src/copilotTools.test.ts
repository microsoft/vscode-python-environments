// import * as assert from 'assert';
// import * as vscode from 'vscode';
// import { GetPackagesTool } from './copilotTools';
// import { Package, PackageId, PackageInfo, PythonEnvironmentApi } from './api';
// import { IGetActiveFile } from './copilotTools';
// import * as sinon from 'sinon';

// suite('GetPackagesTool Tests', () => {
//     let tool: GetPackagesTool;
//     let mockApi: sinon.SinonStubbedInstance<PythonEnvironmentApi>;

//     setup(() => {
//         tool = new GetPackagesTool();
//         // Create a stub instance of the PythonEnvironmentApi interface
//         mockApi = sinon.createStubInstance<PythonEnvironmentApi>({} as any);
//     });

//     test('should throw error if filePath is undefined', async () => {
//         const testFile: IGetActiveFile = {
//             filePath: '',
//         };
//         const options = { input: testFile, toolInvocationToken: undefined };
//         const token = new vscode.CancellationTokenSource().token;
//         await assert.rejects(tool.invoke(options, token), { message: 'Invalid input: filePath is required' });
//     });

//     test('should throw error for notebook files', async () => {
//         const testFile: IGetActiveFile = {
//             filePath: 'test.ipynb',
//         };
//         const options = { input: testFile, toolInvocationToken: undefined };
//         const token = new vscode.CancellationTokenSource().token;
//         await assert.rejects(tool.invoke(options, token), {
//             message: 'Unable to access Jupyter kernels for notebook cells',
//         });
//     });

//     test('should throw error for notebook cells', async () => {
//         const testFile: IGetActiveFile = {
//             filePath: 'test.ipynb#cell',
//         };
//         const options = { input: testFile, toolInvocationToken: undefined };
//         const token = new vscode.CancellationTokenSource().token;
//         await assert.rejects(tool.invoke(options, token), {
//             message: 'Unable to access Jupyter kernels for notebook cells',
//         });
//     });

//     test('should return no packages message if no packages are installed', async () => {
//         const testFile: IGetActiveFile = {
//             filePath: 'abc.py',
//         };
//         const options = { input: testFile, toolInvocationToken: undefined };
//         const token = new vscode.CancellationTokenSource().token;

//         // Stub the getPackages function to return an empty array
//         const pkg1ID: PackageId = { id: 'package1', managerId: 'pip', environmentId: 'env1' };
//         const package1: Package = { pkgId: pkg1ID, name: 'pkg1', displayName: 'pkg1' };
//         mockApi.getPackages.resolves([package1]);

//         const result = await tool.invoke(options, token);
//         assert.strictEqual(result.parts[0].text, 'No packages are installed in the current environment.');
//     });

//     test('should return installed packages', async () => {
//         const options = { input: { filePath: 'test.py' } };
//         const token = new vscode.CancellationTokenSource().token;

//         // Stub the getPackages function to return a list of packages
//         mockApi.getPackages.resolves([{ name: 'package1' }, { name: 'package2' }]);
//         (getPythonApi as any) = async () => mockApi;

//         const result = await tool.invoke(options, token);
//         assert.strictEqual(
//             result.parts[0].text,
//             'The packages installed in the current environment are as follows:\npackage1, package2',
//         );
//     });

//     test('should handle cancellation', async () => {
//         const options = { input: { filePath: 'test.py' } };
//         const tokenSource = new vscode.CancellationTokenSource();
//         const token = tokenSource.token;

//         // Stub the getPackages function to return a list of packages
//         mockApi.getPackages.resolves([{ name: 'package1' }, { name: 'package2' }]);
//         (getPythonApi as any) = async () => mockApi;

//         tokenSource.cancel();
//         await assert.rejects(tool.invoke(options, token), { message: 'Operation cancelled' });
//     });
// });
