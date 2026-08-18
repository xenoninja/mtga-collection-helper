#!/usr/bin/env python3
"""Merge MTGA card printings by name into one collection CSV."""

import argparse
import csv
from pathlib import Path

OUTPUT_FIELDS = ("Id", "Name", "Set", "Color", "Rarity", "Count")
# Basic is included for basic-land printings, which should remain Basic.
RARITY_PRIORITY = {
    "Basic": 0,
    "Uncommon": 1,
    "Common": 2,
    "Rare": 3,
    "Mythic": 4,
}


def convert(input_path: Path, output_path: Path) -> tuple[int, int]:
    with input_path.open(newline="", encoding="utf-8") as source:
        reader = csv.DictReader(source)
        missing_fields = set((*OUTPUT_FIELDS, "PrintCount")) - set(reader.fieldnames or ())
        if missing_fields:
            missing = ", ".join(sorted(missing_fields))
            raise ValueError(f"missing required columns: {missing}")

        cards_by_name: dict[str, dict[str, str]] = {}
        input_count = 0

        for row in reader:
            input_count += 1
            name = row["Name"]
            rarity = row["Rarity"]
            if rarity not in RARITY_PRIORITY:
                raise ValueError(f"unknown rarity {rarity!r} for {name!r}")

            current = cards_by_name.get(name)
            if current is None:
                cards_by_name[name] = row
                continue

            if row["Count"] != current["Count"]:
                raise ValueError(
                    f"inconsistent Count for {name!r}: "
                    f"{current['Count']} and {row['Count']}"
                )

            if RARITY_PRIORITY[rarity] < RARITY_PRIORITY[current["Rarity"]]:
                cards_by_name[name] = row

    with output_path.open("w", newline="", encoding="utf-8") as destination:
        writer = csv.DictWriter(destination, fieldnames=OUTPUT_FIELDS, lineterminator="\n")
        writer.writeheader()
        for row in cards_by_name.values():
            writer.writerow({field: row[field] for field in OUTPUT_FIELDS})

    return input_count, len(cards_by_name)


def main() -> None:
    collection_dir = Path(__file__).resolve().parent / "collection"
    parser = argparse.ArgumentParser(
        description="Merge same-name MTGA printings, keeping the preferred rarity."
    )
    parser.add_argument(
        "input",
        nargs="?",
        type=Path,
        default=collection_dir / "collection_raw.csv",
        help="raw collection CSV (default: collection/collection_raw.csv)",
    )
    parser.add_argument(
        "output",
        nargs="?",
        type=Path,
        default=collection_dir / "collection.csv",
        help="merged collection CSV (default: collection/collection.csv)",
    )
    args = parser.parse_args()

    try:
        input_count, output_count = convert(args.input, args.output)
    except (OSError, ValueError) as error:
        parser.error(str(error))

    print(
        f"Wrote {output_count} cards to {args.output} "
        f"({input_count - output_count} duplicate printings removed)."
    )


if __name__ == "__main__":
    main()
