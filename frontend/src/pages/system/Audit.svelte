<!--
SPDX-FileCopyrightText: 2026 Kevin Stenzel

SPDX-License-Identifier: GPL-3.0-or-later
-->

<script lang="ts">
  import AuditLog from '$lib/components/AuditLog.svelte';
  import { t } from '$lib/i18n';
</script>

<section class="section">
  <header class="page-header">
    <div>
      <h1 class="page-title">{$t('systemAudit.title')}</h1>
      <p class="page-subtitle">{$t('systemAudit.subtitle')}</p>
    </div>
  </header>
  <AuditLog scope="system" />
</section>
