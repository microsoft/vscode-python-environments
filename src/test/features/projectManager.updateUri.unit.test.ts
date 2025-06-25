import assert from 'assert';
import { Uri } from 'vscode';
import { PythonProject } from '../../api';
import { PythonProjectManagerImpl } from '../../features/projectManager';

suite('Project Manager Update URI tests', () => {
    let projectManager: PythonProjectManagerImpl;

    setup(() => {
        projectManager = new PythonProjectManagerImpl();
    });

    teardown(() => {
        projectManager.dispose();
    });

    test('updateProjectUri should update existing project URI', () => {
        const oldUri = Uri.file('/path/to/old/project');
        const newUri = Uri.file('/path/to/new/project');

        // Create a project and manually add it to the internal map to bypass the complex add method
        const project = projectManager.create('TestProject', oldUri, {
            description: 'Test project',
            tooltip: 'Test tooltip',
        });

        // Access private _projects map to manually add the project for testing
        (projectManager as unknown as { _projects: Map<string, PythonProject> })._projects.set(
            oldUri.toString(),
            project,
        );

        // Verify project exists with old URI
        const oldProject = projectManager.get(oldUri);
        assert.ok(oldProject, 'Project should exist with old URI');
        assert.equal(oldProject.uri.fsPath, oldUri.fsPath, 'Old URI should match');

        // Update the project URI
        projectManager.updateProject(oldUri, 'project', newUri);

        // Verify project no longer exists with old URI
        const oldProjectAfterUpdate = projectManager.get(oldUri);
        assert.equal(oldProjectAfterUpdate, undefined, 'Project should not exist with old URI after update');

        // Verify project exists with new URI
        const newProject = projectManager.get(newUri);
        assert.ok(newProject, 'Project should exist with new URI');
        assert.equal(newProject.uri.fsPath, newUri.fsPath, 'New URI should match');
        assert.equal(newProject.name, 'project', 'Project name should be based on new path');
        assert.equal(newProject.description, 'Test project', 'Description should be preserved');
        assert.equal(newProject.tooltip, 'Test tooltip', 'Tooltip should be preserved');
    });

    test('updateProjectUri should handle non-existent project gracefully', () => {
        const oldUri = Uri.file('/path/to/nonexistent/project');
        const newUri = Uri.file('/path/to/new/project');

        // Try to update a project that doesn't exist
        // This should not throw an error
        assert.doesNotThrow(() => {
            projectManager.updateProject(oldUri, 'project', newUri);
        }, 'Should handle non-existent project gracefully');

        // Verify no project was created
        const newProject = projectManager.get(newUri);
        assert.equal(newProject, undefined, 'No project should be created for non-existent old project');
    });

    test('remove should remove multiple projects', () => {
        const project1Uri = Uri.file('/path/to/project1');
        const project2Uri = Uri.file('/path/to/project2');

        // Create projects and manually add them to the internal map
        const project1 = projectManager.create('Project1', project1Uri);
        const project2 = projectManager.create('Project2', project2Uri);

        // Access private _projects map to manually add projects for testing
        const pmWithPrivateAccess = projectManager as unknown as { _projects: Map<string, PythonProject> };
        pmWithPrivateAccess._projects.set(project1Uri.toString(), project1);
        pmWithPrivateAccess._projects.set(project2Uri.toString(), project2);

        // Verify both projects exist
        assert.ok(projectManager.get(project1Uri), 'Project1 should exist');
        assert.ok(projectManager.get(project2Uri), 'Project2 should exist');

        // Remove both projects
        projectManager.remove([project1, project2]);

        // Verify both projects are removed
        assert.equal(projectManager.get(project1Uri), undefined, 'Project1 should be removed');
        assert.equal(projectManager.get(project2Uri), undefined, 'Project2 should be removed');
    });
});
