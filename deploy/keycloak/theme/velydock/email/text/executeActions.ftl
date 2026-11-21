<#ftl output_format="plainText">
<#-- Keycloak's template (base/email/text/executeActions.ftl) with one more value for the text: the user name ({5}). -->
<#assign requiredActionsText><#if requiredActions??><#list requiredActions><#items as reqActionItem>${msg("requiredAction.${reqActionItem}")}<#sep>, </#items></#list><#else></#if></#assign>

${msg("executeActionsBody",link, linkExpiration, realmName, requiredActionsText, linkExpirationFormatter(linkExpiration), user.username!"")}
