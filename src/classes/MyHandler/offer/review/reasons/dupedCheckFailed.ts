import SKU from 'tf2-sku-2';
import pluralize from 'pluralize';
import { Meta, DupeCheckFailed } from 'steam-tradeoffer-manager';
import Bot from '../../../../Bot';

export default function dupedCheckFailed(meta: Meta, bot: Bot): { note: string; name: string[] } {
    const opt = bot.options.discordWebhook.offerReview;
    const dupedFailedItemsNameOur: string[] = [];
    const dupedFailedItemsNameTheir: string[] = [];

    (meta.reasons.filter(el => el.reason.includes('🟪_DUPE_CHECK_FAILED')) as DupeCheckFailed[]).forEach(el => {
        if (el.withError === false) {
            // If 🟪_DUPE_CHECK_FAILED occurred without error, then this sku/assetid is string.

            if (opt.enable && opt.url !== '') {
                // if Discord Webhook for review offer enabled, then make it link the item name to the backpack.tf item history page.
                dupedFailedItemsNameOur.push(
                    `_${bot.schema.getName(
                        SKU.fromString(el.sku as string),
                        false
                    )}_ - [history page](https://backpack.tf/item/${el.assetid as string})`
                );
            } else {
                // else Discord Webhook for review offer disabled, make the link to backpack.tf item history page separate with name.
                dupedFailedItemsNameOur.push(
                    `${bot.schema.getName(
                        SKU.fromString(el.sku as string),
                        false
                    )}, history page: https://backpack.tf/item/${el.assetid as string}`
                );
            }
            dupedFailedItemsNameTheir.push(
                `${bot.schema.getName(
                    SKU.fromString(el.sku as string),
                    false
                )}, history page: https://backpack.tf/item/${el.assetid as string}`
            );
        } else {
            // Else if 🟪_DUPE_CHECK_FAILED occurred with error, then this sku/assetid is string[].
            for (let i = 0; i < el.sku.length; i++) {
                if (opt.enable && opt.url !== '') {
                    // if Discord Webhook for review offer enabled, then make it link the item name to the backpack.tf item history page.
                    dupedFailedItemsNameOur.push(
                        `_${bot.schema.getName(
                            SKU.fromString(el.sku[i]),
                            false
                        )}_ - [history page](https://backpack.tf/item/${el.assetid[i]})`
                    );
                } else {
                    // else Discord Webhook for review offer disabled, make the link to backpack.tf item history page separate with name.
                    dupedFailedItemsNameOur.push(
                        `${bot.schema.getName(
                            SKU.fromString(el.sku[i]),
                            false
                        )}, history page: https://backpack.tf/item/${el.assetid[i]}`
                    );
                }
                dupedFailedItemsNameTheir.push(
                    `${bot.schema.getName(SKU.fromString(el.sku[i]), false)}, history page: https://backpack.tf/item/${
                        el.assetid[i]
                    }`
                );
            }
        }
    });

    return {
        note: bot.options.manualReview.dupedCheckFailed.note
            ? `🟪_DUPE_CHECK_FAILED - ${bot.options.manualReview.dupedCheckFailed.note}`
                  .replace(/%itemsName%/g, dupedFailedItemsNameTheir.join(', '))
                  .replace(/%isOrAre%/g, pluralize('is', dupedFailedItemsNameTheir.length))
            : `🟪_DUPE_CHECK_FAILED - I failed to check for duped on ${dupedFailedItemsNameTheir.join(', ')}.`,
        // Default note: I failed to check for duped on %itemsName%.
        name: dupedFailedItemsNameOur
    };
}
