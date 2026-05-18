import sys


def main() -> int:
    if len(sys.argv) < 3:
        sys.stderr.write("Usage: weasyprint_render.py <input.html> <output.pdf>\n")
        return 2

    input_html = sys.argv[1]
    output_pdf = sys.argv[2]

    try:
        from weasyprint import HTML  # type: ignore
    except Exception as e:
        sys.stderr.write(f"WeasyPrint is not installed: {e}\n")
        return 3

    HTML(filename=input_html).write_pdf(output_pdf)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

