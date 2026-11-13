"""Writes the binary importer fixtures (BLS ZIP/XLSX, USDA ZIP, OFF JSONL.GZ) deterministically.

Formats mirror the real releases inspected on 2026-10-17 (see docs/research.md); every row is synthetic.
Run from this directory: python3 -I make_fixtures.py
"""
import gzip
import io
import json
import zipfile

STAMP = (2099, 1, 1, 0, 0, 0)


def check(body):
    padded = body.rjust(13, "0")
    total = sum(int(d) * (3 if i % 2 == 0 else 1) for i, d in enumerate(padded))
    return body + str((10 - total % 10) % 10)


def zwrite(z, name, data):
    info = zipfile.ZipInfo(name, STAMP)
    info.compress_type = zipfile.ZIP_DEFLATED
    z.writestr(info, data)


UPC = check("03600029145")  # 12-digit UPC shared by a USDA branded food and an OFF product
EAN = check("400638133393")
RCN = check("201234500000")  # GS1 prefix 20: restricted circulation, never grouped


def bls():
    strings = ["BLS Code", "Lebensmittelbezeichnung", "Food name",
               "ENERCC Energie (Kilokalorien) [kcal/100g]", "ENERCC Datenherkunft", "ENERCC Referenz",
               "FIBT Ballaststoffe, gesamt [g/100g]", "FIBT Datenherkunft", "FIBT Referenz",
               "TOCPHG Gamma-Tocopherol [mg/100g]", "TOCPHG Datenherkunft", "TOCPHG Referenz",
               "X100001", "Testhafer ganzes Korn, roh", "Test oat whole grain, raw", "Formelberechnung", "-",
               "<LOQ", "Literatur", "X100002", "Testflocken", "Analyse", "Ohne Code"]
    s = {v: i for i, v in enumerate(strings)}

    def c(ref, value, kind="s"):
        if kind == "s":
            return f'<c r="{ref}" t="s"><v>{s[value]}</v></c>'
        if kind == "inline":
            return f'<c r="{ref}" t="inlineStr"><is><t>{value}</t></is></c>'
        return f'<c r="{ref}" s="1"><v>{value}</v></c>'

    header = "".join(c(f"{col}1", strings[i]) for i, col in enumerate("ABCDEFGHIJKL"))
    rows = [
        f'<row r="1">{header}</row>',
        '<row r="2">' + "".join([
            c("A2", "X100001"), c("B2", "Testhafer ganzes Korn, roh"), c("C2", "Test oat whole grain, raw"),
            c("D2", "343", "n"), c("E2", "Formelberechnung"), c("F2", "-"),
            c("G2", "9.3000000000000007", "n"), c("H2", "Analyse"), c("I2", "-"),
            c("J2", "<LOQ"), c("K2", "Literatur"), c("L2", "-")]) + "</row>",
        '<row r="3">' + "".join([
            c("A3", "X100002"), c("B3", "Testflocken"), c("C3", "Test oat flakes", "inline"),
            c("D3", "1.4999999999999999E-2", "n"), c("G3", "-")]) + "</row>",
        '<row r="4"/>',
        '<row r="5">' + c("B5", "Ohne Code") + "</row>",
    ]
    sheet = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
             '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
             f'<dimension ref="A1:L5"/><sheetData>{"".join(rows)}</sheetData></worksheet>')
    shared = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
              f'<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="{len(strings)}" uniqueCount="{len(strings)}">'
              + "".join(f"<si><t>{v.replace('<', '&lt;')}</t></si>" for v in strings) + "</sst>")
    workbook = io.BytesIO()
    with zipfile.ZipFile(workbook, "w") as z:
        zwrite(z, "[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
        zwrite(z, "xl/workbook.xml", '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="Tabelle1" sheetId="1"/></sheets></workbook>')
        zwrite(z, "xl/sharedStrings.xml", shared)
        zwrite(z, "xl/worksheets/sheet1.xml", sheet)
    with zipfile.ZipFile("bls.zip", "w") as z:
        zwrite(z, "BLS_4_0_2025_DE/BLS_4_0_Daten_2025_DE.xlsx", workbook.getvalue())
        zwrite(z, "BLS_4_0_2025_DE/BLS_4_0_Dokumentation_DE.pdf", b"%PDF-1.4 synthetic")


def csv(rows):
    return "".join(",".join('"' + v.replace('"', '""') + '"' for v in row) + "\n" for row in rows)


def usda():
    root = "FoodData_Central_csv_2099-01-01/"
    food = [["fdc_id", "data_type", "description", "food_category_id", "publication_date"],
            ["900001", "branded_food", "TEST OATS, ROLLED", "Cereal", "2099-01-01"],
            ["900002", "sr_legacy_food", "Test oats, raw", "Cereal", "2099-01-01"],
            ["900003", "sub_sample_food", "Test oats sample", "", "2099-01-01"],
            ["900004", "market_acquistion", "Test oats acquisition", "", "2099-01-01"],
            ["900005", "branded_food", 'TEST "QUOTED" BAR, WITH\nNEWLINE', "Snacks", "2099-01-01"],
            ["900006", "experimental_food", "Test oats, experimental cultivar", "", "2099-01-01"],
            ["", "branded_food", "NO ID", "", ""]]
    nutrient = [["id", "name", "unit_name", "nutrient_nbr", "rank"],
                ["1008", "Energy", "KCAL", "208", "300.0"],
                ["1003", "Protein", "G", "203", "600.0"]]
    food_nutrient = [["id", "fdc_id", "nutrient_id", "amount", "data_points", "derivation_id", "min", "max", "median", "loq", "footnote", "min_year_acquired", "percent_daily_value"],
                     ["1", "900001", "1008", "379.0", "", "71", "", "", "", "", "", "", ""],
                     ["2", "900001", "1003", "13.15", "", "71", "", "", "", "", "", "", ""],
                     ["3", "900002", "1008", "389", "", "", "", "", "", "", "", "", ""],
                     ["4", "900005", "1003", "", "", "", "", "", "", "", "", "", ""],
                     ["5", "900003", "1008", "1", "", "", "", "", "", "", "", "", ""],
                     ["6", "900006", "1003", "14.1", "", "", "", "", "", "", "", "", ""]]
    branded_cols = ["fdc_id", "brand_owner", "brand_name", "subbrand_name", "gtin_upc", "ingredients", "not_a_significant_source_of", "serving_size", "serving_size_unit", "household_serving_fulltext", "branded_food_category", "data_source", "package_weight", "modified_date", "available_date", "market_country", "discontinued_date", "preparation_state_code", "trade_channel", "short_description", "material_code"]

    def branded(fdc, owner, brand, gtin, size, unit, household, prep):
        row = dict.fromkeys(branded_cols, "")
        row.update(fdc_id=fdc, brand_owner=owner, brand_name=brand, gtin_upc=gtin, serving_size=size,
                   serving_size_unit=unit, household_serving_fulltext=household, preparation_state_code=prep)
        return [row[c] for c in branded_cols]

    branded_food = [branded_cols,
                    branded("900001", "Test Mills Inc.", "TESTBRAND", UPC.rjust(14, "0"), "40.0", "g", "1/2 cup (40 g)", ""),
                    branded("900005", "Bar Co", "", "0-41190-06938-5", "45.0", "g", "", "READY_TO_EAT")]
    food_portion = [["id", "fdc_id", "seq_num", "amount", "measure_unit_id", "portion_description", "modifier", "gram_weight", "data_points", "footnote", "min_year_acquired"],
                    ["11", "900002", "2", "1.0", "9999", "", "serving", "40.0", "", "", ""],
                    ["10", "900002", "1", "1.0", "1000", "", "", "81.0", "", "", ""]]
    measure_unit = [["id", "name"], ["1000", "cup"], ["9999", "undetermined"]]
    market_acquisition = [["fdc_id", "brand_description", "expiration_date", "label_weight", "location", "acquisition_date", "sales_type", "sample_lot_nbr", "sell_by_date", "store_city", "store_name", "store_state", "upc_code", "acquisition_number"],
                          ["900004", "Acquired Testbrand", "2099-02-01", "", "NE1", "2099-01-01", "", "10:0823 ", "", "TESTTOWN", "TEST MART", "NE", UPC, "SYN0001"]]
    with zipfile.ZipFile("usda.zip", "w") as z:
        zwrite(z, root, b"")
        for name, rows in [("food", food), ("nutrient", nutrient), ("food_nutrient", food_nutrient),
                           ("branded_food", branded_food), ("food_portion", food_portion), ("measure_unit", measure_unit),
                           ("market_acquisition", market_acquisition)]:
            zwrite(z, f"{root}{name}.csv", csv(rows))
        zwrite(z, f"{root}food_attribute.csv", csv([["id", "fdc_id"]]))


def off():
    products = [
        {"code": UPC, "product_name": "Test Rolled Oats", "brands": "Testbrand", "serving_size": "40 g",
         "nutriments": {"energy-kcal_100g": 375, "proteins_100g": 12.5, "proteins_unit": "g", "proteins_serving": 5}},
        {"code": EAN, "product_name": "Testflocken", "product_name_en": "Test flakes", "schema_version": 1004,
         "nutrition": {"input_sets": [
             {"source": "packaging", "preparation": "as_sold", "per": "100g", "nutrients": {
                 "salt": {"value": 0.5, "value_string": "0.5", "modifier": "<", "unit": "g"},
                 "energy-kcal": {"value": 361, "value_string": "361", "unit": "kcal"}}},
             {"source": "estimate", "preparation": "as_sold", "per": "100g", "nutrients": {
                 "fruits-vegetables-nuts": {"value": 0, "unit": "%"}}}]}},
        "{not json",
        {"product_name": "No code"},
        {"code": UPC, "product_name": "Duplicate of the first line"},
        {"code": "0000000000017", "product_name": "Bad\u0000name"},
        {"code": RCN, "product_name": "Store-weighed oats"},
        {"code": "5000000000001", "product_name": ""},
    ]
    lines = [p if isinstance(p, str) else json.dumps(p, ensure_ascii=False) for p in products]
    with open("off.jsonl.gz", "wb") as f:
        with gzip.GzipFile(fileobj=f, mode="wb", mtime=0) as gz:
            gz.write(("\n".join(lines) + "\n").encode())


bls()
usda()
off()
print("UPC", UPC, "EAN", EAN, "RCN", RCN)
