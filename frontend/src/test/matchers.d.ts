// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Makes the jest-dom matchers (toBeInTheDocument, toHaveAttribute, …) known to the type
// checker; vitest.setup.ts registers them at run time.
import '@testing-library/jest-dom/vitest';
