import argparse
import re
from pathlib import Path


RE_TAMIL = re.compile(r"[\u0B80-\u0BFF]")
RE_HINDI = re.compile(r"[\u0900-\u097F]")
RE_ENGLISH = re.compile(r"[A-Za-z]")


def script_of_char(ch: str) -> str:
    cp = ord(ch)
    if 0x0B80 <= cp <= 0x0BFF:
        return "ta"
    if 0x0900 <= cp <= 0x097F:
        return "hi"
    if ("A" <= ch <= "Z") or ("a" <= ch <= "z"):
        return "en"
    return "other"


def split_by_language_boundaries(line: str):
    ta_start = None
    hi_start = None

    for i, ch in enumerate(line):
        s = script_of_char(ch)
        if ta_start is None and s == "ta":
            ta_start = i
        elif ta_start is not None and hi_start is None and s == "hi":
            hi_start = i
            break

    if ta_start is None:
        return None, "Tamil boundary not found"
    if hi_start is None:
        return None, "Hindi boundary not found"

    english = line[:ta_start].strip(" \t,")
    tamil = line[ta_start:hi_start].strip(" \t,")
    hindi = line[hi_start:].strip(" \t,")

    en_ok = bool(RE_ENGLISH.search(english))
    ta_ok = bool(RE_TAMIL.search(tamil))
    hi_ok = bool(RE_HINDI.search(hindi))

    return (english, tamil, hindi, en_ok, ta_ok, hi_ok), None


def convert_file(input_path: Path, output_path: Path):
    out_lines = []

    for ln, raw in enumerate(input_path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw.strip()
        if not line:
            continue

        result, err = split_by_language_boundaries(line)
        if err:
            print(f"line {ln}: {err}")
            continue

        english, tamil, hindi, en_ok, ta_ok, hi_ok = result
        print(f"line {ln}: EN->{en_ok} TA->{ta_ok} HI->{hi_ok}")
        out_lines.append(f"{english}\t{tamil}\t{hindi}")

    output_path.write_text("\n".join(out_lines) + ("\n" if out_lines else ""), encoding="utf-8")
    print(f"\nWritten: {output_path}")


def main():
    parser = argparse.ArgumentParser(
        description="Detect EN/TA/HI language boundaries by Unicode and write tab-separated output."
    )
    parser.add_argument("-i", "--input", default="subtitles.csv", help="Input CSV file path")
    parser.add_argument("-o", "--output", default="subtitles_1.csv", help="Output file path")
    args = parser.parse_args()

    convert_file(Path(args.input), Path(args.output))


if __name__ == "__main__":
    main()
