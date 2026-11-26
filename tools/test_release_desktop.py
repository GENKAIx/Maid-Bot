"""Проверка tools/release-desktop.py без сборки и сервера: разбор --notes / --notes-file / --percent, по умолчанию — сразу всем (100).

    python tools/test_release_desktop.py
"""
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("release_desktop", HERE / "release-desktop.py")
rd = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rd)  # main() не запускается: он только под __main__


class ReleaseArgs(unittest.TestCase):
    def test_default_is_everyone(self):
        a = rd.parse_args([])
        self.assertEqual(a.percent, 100)
        self.assertEqual(rd.START_PERCENT, 100)
        self.assertIsNone(a.version)
        self.assertFalse(a.no_upload)
        self.assertEqual(a.notes_list, [])
        self.assertEqual(rd.with_staging("version: 0.1.95\nstagingPercentage: 20\n", a.percent), "version: 0.1.95\nstagingPercentage: 100\n")

    def test_percent_only_explicit(self):
        self.assertEqual(rd.parse_args(["--percent=20"]).percent, 20)
        self.assertEqual(rd.parse_args(["--percent", "50", "0.2.0"]).percent, 50)
        for bad in ["0", "101", "abc", "2.5"]:
            with self.assertRaises(SystemExit, msg=bad):
                rd.parse_args([f"--percent={bad}"])

    def test_notes_inline(self):
        a = rd.parse_args(["0.1.95", "--notes", " Первое | - Второе ||  Третье "])
        self.assertEqual(a.version, "0.1.95")
        self.assertEqual(a.notes_list, ["Первое", "Второе", "Третье"])
        self.assertEqual(rd.parse_args(["--notes=раз | два"]).notes_list, ["раз", "два"])

    def test_notes_file(self):
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / "notes.txt"
            f.write_bytes("﻿- Плашки не шире сообщения\r\n\r\n• Стрелка «↗» к задаче\n* «Сегодня» не прыгает\nпросто строка\n".encode("utf-8"))
            self.assertEqual(rd.parse_args(["--notes-file", str(f)]).notes_list,
                             ["Плашки не шире сообщения", "Стрелка «↗» к задаче", "«Сегодня» не прыгает", "просто строка"])
            with self.assertRaises(SystemExit):
                rd.parse_args(["--notes-file", str(Path(d) / "нет.txt")])
            with self.assertRaises(SystemExit):
                rd.parse_args(["--notes", "а", "--notes-file", str(f)])

    def test_notes_limits(self):
        self.assertEqual(len(rd.clean_notes([f"п{i}" for i in range(12)])), 12)
        self.assertEqual(rd.clean_notes(["я" * 200]), ["я" * 200])
        self.assertEqual(rd.clean_notes(["2 < 3 -> да"]), ["2 < 3 -> да"])
        for bad in [[f"п{i}" for i in range(13)], ["я" * 201], ["<b>жирно</b>"], ["<script>x</script>"]]:
            with self.assertRaises(SystemExit, msg=str(bad)[:40]):
                rd.clean_notes(bad)

    def test_notes_json_and_warning(self):
        j = json.loads(rd.notes_json("0.1.95", ["а", "б"]))
        self.assertEqual(j, {"version": "0.1.95", "notes": ["а", "б"]})
        self.assertIn("«", rd.notes_json("0.1.95", ["«в»"]), "по-русски, без \\u-экранов")
        self.assertIn("без «что нового»", rd.notes_warning([]))
        self.assertIn("3–7", rd.notes_warning(["а"]))
        self.assertIsNone(rd.notes_warning(["а", "б", "в"]))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    unittest.main(verbosity=1)
