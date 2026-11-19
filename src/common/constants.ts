import * as path from 'path';

export const ENVS_EXTENSION_ID = 'ms-python.vscode-python-envs';
export const PYTHON_EXTENSION_ID = 'ms-python.python';
export const PYLANCE_EXTENSION_ID = 'ms-python.vscode-pylance';

// Manager IDs
export const CONDA_MANAGER_ID = `${PYTHON_EXTENSION_ID}:conda`;
export const INLINE_SCRIPT_MANAGER_ID = `${PYTHON_EXTENSION_ID}:inline-script`;
export const INLINE_SCRIPT_ENVS_KEY = `${ENVS_EXTENSION_ID}:inline-script:SCRIPT_ENVIRONMENTS`;
export const PYENV_MANAGER_ID = `${PYTHON_EXTENSION_ID}:pyenv`;
export const PIPENV_MANAGER_ID = `${PYTHON_EXTENSION_ID}:pipenv`;
export const POETRY_MANAGER_ID = `${PYTHON_EXTENSION_ID}:poetry`;
export const PIXI_MANAGER_ID = `${PYTHON_EXTENSION_ID}:pixi`;
export const HATCH_MANAGER_ID = `${PYTHON_EXTENSION_ID}:hatch`;
export const PIP_MANAGER_ID = `${PYTHON_EXTENSION_ID}:pip`;
export const UV_MANAGER_ID = `${PYTHON_EXTENSION_ID}:uv`;
export const VENV_MANAGER_ID = `${PYTHON_EXTENSION_ID}:venv`;
export const SYSTEM_MANAGER_ID = `${PYTHON_EXTENSION_ID}:system`;

export const DEFAULT_PACKAGE_MANAGER_ID = PIP_MANAGER_ID;
export const DEFAULT_ENV_MANAGER_ID = VENV_MANAGER_ID;

export const JUPYTER_EXTENSION_ID = 'ms-toolsai.jupyter';
export const EXTENSION_ROOT_DIR = path.dirname(__dirname);
export const ISSUES_URL = 'https://github.com/microsoft/vscode-python-environments/issues';

export const KNOWN_FILES = [
    'requirements.txt',
    'requirements.in',
    '.condarc',
    '.python-version',
    'environment.yml',
    'pyproject.toml',
    'meta.yaml',
    '.flake8',
    '.pep8',
    '.pylintrc',
    '.pypirc',
    'Pipfile',
    'poetry.lock',
    'Pipfile.lock',
];

export const KNOWN_TEMPLATE_ENDINGS = ['.j2', '.jinja2'];

export const NEW_PROJECT_TEMPLATES_FOLDER = path.join(EXTENSION_ROOT_DIR, 'files', 'templates');
export const NotebookCellScheme = 'vscode-notebook-cell';
