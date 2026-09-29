"""Regression tests for OpenAI form protocol validation."""

from __future__ import annotations

import unittest

from openai_mcp_form_protocol import (
    FormField,
    FormSchema,
    complete_field_submission,
    is_valid_value,
    prepare_field_submission,
    validate_file_selections,
)


class FormProtocolTests(unittest.TestCase):
    def test_schema_rejects_required_fields_without_properties(self) -> None:
        with self.assertRaises(ValueError, msg="Form requires an unknown field"):
            FormSchema[FormField].model_validate(
                {"type": "object", "properties": {}, "required": ["missing"]}
            )

    def test_integer_constraints_reject_booleans_and_out_of_range_values(self) -> None:
        field = FormField(type="integer", minimum=1, maximum=3)

        self.assertTrue(is_valid_value(field, 2))
        self.assertFalse(is_valid_value(field, True))
        self.assertFalse(is_valid_value(field, 4))

    def test_multiselect_requires_unique_values(self) -> None:
        field = FormField(
            type="array",
            items={"anyOf": [{"const": "small", "title": "Small"}]},
            uniqueItems=True,
        )

        self.assertTrue(is_valid_value(field, ["small"]))
        self.assertFalse(is_valid_value(field, ["small", "small"]))

    def test_explicit_file_selection_only_accepts_listed_resources(self) -> None:
        field = FormField(
            type="string",
            format="uri",
            **{
                "x-openai-input": {
                    "type": "resource",
                    "options": [{"uri": "file:///parts/bracket.step", "name": "bracket.step"}],
                }
            },
        )
        schema = FormSchema[FormField](type="object", properties={"part": field})

        validate_file_selections(schema, {"part": "file:///parts/bracket.step"})
        with self.assertRaisesRegex(ValueError, "Invalid resource selection"):
            validate_file_selections(schema, {"part": "file:///private/other.step"})

    def test_implicit_file_selection_allows_user_files(self) -> None:
        schema = FormSchema[FormField].model_validate(
            {
                "type": "object",
                "properties": {
                    "parts": {
                        "type": "array",
                        "items": {"type": "string", "format": "uri"},
                        "x-openai-input": {
                            "type": "resource",
                            "options": [],
                            "selection": "implicit",
                        },
                    }
                },
            }
        )

        validate_file_selections(schema, {"parts": ["file:///user/selected.step"]})

    def test_upload_constraints_are_checked_before_and_after_upload(self) -> None:
        field = FormField(
            type="string",
            format="uri",
            **{
                "x-openai-input": {
                    "type": "resource",
                    "options": [],
                    "userOptions": {"kind": "file", "accept": [".step", "model/step"]},
                }
            },
        )

        self.assertEqual(
            prepare_field_submission(field, "part", {}, pending_uploads=1),
            (".step", "model/step"),
        )
        self.assertEqual(
            complete_field_submission(
                field,
                "part",
                {},
                ("file:///uploads/part.step",),
            ),
            "file:///uploads/part.step",
        )
        with self.assertRaisesRegex(ValueError, "does not accept files"):
            prepare_field_submission(
                field.model_copy(update={"file_input": None}), "part", {}, pending_uploads=1
            )

    def test_implicit_selection_defaults_user_file_options(self) -> None:
        field = FormField.model_validate(
            {
                "type": "array",
                "items": {"type": "string", "format": "uri"},
                "x-openai-input": {
                    "type": "resource",
                    "options": [{"uri": "file:///parts/bracket.step", "name": "bracket.step"}],
                    "selection": "implicit",
                },
            }
        )

        self.assertIsNotNone(field.file_input)
        self.assertIsNotNone(field.file_input.user_options)


if __name__ == "__main__":
    unittest.main()
