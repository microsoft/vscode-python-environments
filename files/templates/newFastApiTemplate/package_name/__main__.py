import uvicorn

from package_name.main import app


def main() -> None:
    uvicorn.run(app, host="127.0.0.1", port=8000)


if __name__ == "__main__":
    main()
