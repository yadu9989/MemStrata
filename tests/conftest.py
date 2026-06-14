"""Shared test fixtures — V5.2-E E.2.

The Open repo has no Pro overlay to mount; api_server's NoOp defaults
(``_NoOpCohortApi``, absent ``dashboard_extras``) are the production
behavior when this repo runs standalone. Tests that previously asserted
Pro behavior were left in the suite when relevant; they exercise the
Open NoOp path here.

This conftest is intentionally minimal — every fixture lives next to
the test that uses it. The top-level file exists so pytest discovers
the ``tests/`` package as a test root.
"""
from __future__ import annotations
