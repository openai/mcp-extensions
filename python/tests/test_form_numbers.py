"""Run with python -m unittest discover -s python/tests."""

import json
import unittest

from pydantic import ValidationError

from openai_mcp_form_protocol import FormField, is_valid_value, prepare_field_submission


class FormNumberTests(unittest.TestCase):
    def test_integer_json_representations(self) -> None:
        field = FormField(type="integer")
        for literal in ("1", "1.0", "1e0", "-2.0", "-0.0", "1e20"):
            with self.subTest(literal=literal):
                content = json.loads('{"count":' + literal + "}")
                self.assertTrue(is_valid_value(field, content["count"]))
                self.assertIsNone(prepare_field_submission(field, "count", content))
                self.assertEqual(content["count"], json.loads(literal))

    def test_integral_defaults_and_enum_choices(self) -> None:
        for literal in ("1.0", "1e0", "-2.0"):
            with self.subTest(literal=literal):
                field = FormField.model_validate_json(
                    '{"type":"integer","default":' + literal + ',"enum":[' + literal + "]}"
                )
                self.assertTrue(is_valid_value(field, int(json.loads(literal))))
                self.assertTrue(is_valid_value(field, json.loads(literal)))
                self.assertFalse(is_valid_value(field, 7))

    def test_integer_constraints_remain_enforced(self) -> None:
        field = FormField(type="integer", minimum=-2, maximum=2)
        for value, expected in ((-2.0, True), (2.0, True), (-3.0, False), (3.0, False)):
            with self.subTest(value=value):
                self.assertEqual(is_valid_value(field, value), expected)

    def test_noninteger_values_are_rejected_without_coercion(self) -> None:
        field = FormField(type="integer")
        for value in (
            1.5,
            -0.25,
            True,
            False,
            "1",
            None,
            float("nan"),
            float("inf"),
            -float("inf"),
        ):
            with self.subTest(value=value):
                self.assertFalse(is_valid_value(field, value))
                with self.assertRaises(ValueError):
                    prepare_field_submission(field, "count", {"count": value})

    def test_invalid_integer_defaults_and_enums_remain_rejected(self) -> None:
        for value in (1.5, True, "1"):
            for key in ("default", "enum"):
                with self.subTest(value=value, key=key):
                    with self.assertRaises(ValidationError):
                        FormField.model_validate(
                            {"type": "integer", key: [value] if key == "enum" else value}
                        )

    def test_number_fields_still_allow_fractions(self) -> None:
        field = FormField(type="number", minimum=-2, maximum=2)
        for value, expected in ((1.5, True), (-0.25, True), (3.0, False), (True, False)):
            with self.subTest(value=value):
                self.assertEqual(is_valid_value(field, value), expected)


if __name__ == "__main__":
    unittest.main()
