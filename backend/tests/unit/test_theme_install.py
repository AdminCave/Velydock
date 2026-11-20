"""Installing the Keycloak login theme with content-addressed resource paths."""

from __future__ import annotations

from pathlib import Path

import pytest

from velydock.cli import install_theme

REPO_THEME = Path(__file__).resolve().parents[3] / "deploy" / "keycloak" / "theme"


def styles(theme_dir: Path) -> list[str]:
    for line in (theme_dir / "login" / "theme.properties").read_text().splitlines():
        if line.startswith("styles="):
            return line.removeprefix("styles=").split()
    raise AssertionError("no styles line")


@pytest.fixture
def source(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    import shutil

    src = tmp_path / "src"
    shutil.copytree(REPO_THEME, src)
    monkeypatch.setenv("VELYDOCK_THEME_SOURCE_DIR", str(src))
    return src


def test_resources_are_installed_under_a_content_hash(source: Path, tmp_path: Path) -> None:
    target = tmp_path / "themes"
    install_theme(str(target))
    resources = target / "velydock" / "login" / "resources"
    (versioned,) = list(resources.iterdir())
    assert versioned.name.startswith("v-") and len(versioned.name) == 14
    assert (versioned / "css" / "velydock.css").is_file()
    assert (versioned / "img" / "velydock-mark.svg").is_file()
    # The parent theme's style sheet keeps its path, ours points into the versioned directory.
    assert styles(target / "velydock") == ["css/styles.css", f"{versioned.name}/css/velydock.css"]
    # Relative references inside the style sheet still resolve.
    css = (versioned / "css" / "velydock.css").read_text()
    assert "../img/velydock-mark.svg" in css
    assert (target / "velydock" / "login" / "messages" / "messages_de.properties").is_file()


def test_reinstalling_the_same_theme_keeps_the_address(source: Path, tmp_path: Path) -> None:
    target = tmp_path / "themes"
    install_theme(str(target))
    first = styles(target / "velydock")
    install_theme(str(target))
    assert styles(target / "velydock") == first


def test_a_changed_theme_gets_a_new_address_and_leaves_nothing_stale(source: Path, tmp_path: Path) -> None:
    target = tmp_path / "themes"
    install_theme(str(target))
    before = styles(target / "velydock")
    css = source / "velydock" / "login" / "resources" / "css" / "velydock.css"
    css.write_text(css.read_text() + "\n/* changed */\n")
    install_theme(str(target))
    after = styles(target / "velydock")
    assert after != before
    assert len(list((target / "velydock" / "login" / "resources").iterdir())) == 1


def test_files_are_readable_by_keycloak(source: Path, tmp_path: Path) -> None:
    target = tmp_path / "themes"
    install_theme(str(target))
    for path in target.rglob("*"):
        mode = path.stat().st_mode & 0o777
        assert mode == (0o755 if path.is_dir() else 0o644), path
