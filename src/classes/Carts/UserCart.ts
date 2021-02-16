import pluralize from 'pluralize';
import SKU from 'tf2-sku-2';
import Currencies from 'tf2-currencies-2';
import async from 'async';
import { HighValueInput, HighValueOutput, ItemsDict, OurTheirItemsDict, Prices } from 'steam-tradeoffer-manager';
import Cart from './Cart';
import Inventory, { getSkuAmountCanTrade, DictItem } from '../Inventory';
import TF2Inventory from '../TF2Inventory';
import log from '../../lib/logger';
import { noiseMakers } from '../../lib/data';
import { pure } from '../../lib/tools/export';

type WhichHighValue = 'our' | 'their';

type HighValueAttachments = 'sp' | 'ks' | 'ke' | 'p';

export default class UserCart extends Cart {
    /**
     * If we should give keys and metal or only metal (should be able to change this on checkout)
     */
    private useKeys = true;

    protected async preSendOffer(): Promise<void> {
        const [banned, escrow] = await Promise.all([
            this.bot.checkBanned(this.partner),
            this.bot.checkEscrow(this.offer)
        ]);

        if (banned) {
            return Promise.reject('you are banned in one or more trading communities');
        }

        if (escrow) {
            return Promise.reject('trade would be held');
        }

        const keyPrice = this.bot.pricelist.getKeyPrice;

        if (
            this.bot.handler.dupeCheckEnabled &&
            this.getWhichCurrencies('their').toValue(keyPrice.metal) > // theirItemsValue > minimumKeysDupeCheck
                this.bot.handler.minimumKeysDupeCheck * keyPrice.toValue()
        ) {
            const assetidsToCheck = this.offer.data('_dupeCheck') as string[];

            const inventory = new TF2Inventory(this.partner, this.bot.manager);

            const requests = assetidsToCheck.map(assetid => {
                return (callback: (err: Error | null, result: boolean | null) => void): void => {
                    log.debug(`Dupe checking ${assetid}...`);
                    void Promise.resolve(inventory.isDuped(assetid)).asCallback((err, result) => {
                        log.debug(`Dupe check for ${assetid} done`);
                        callback(err, result);
                    });
                };
            });

            try {
                const result: (boolean | null)[] = await Promise.fromCallback(callback => {
                    async.series(requests, callback);
                });

                log.debug(`Got result from dupe checks on ${assetidsToCheck.join(', ')}`, { result: result });

                const resultCount = result.length;

                for (let i = 0; i < resultCount; i++) {
                    if (result[i] === true) {
                        // Found duped item
                        return Promise.reject('offer contains duped items');
                    } else if (result[i] === null) {
                        // Could not determine if the item was duped, make the offer be pending for review
                        return Promise.reject('failed to check for duped items, try sending an offer instead');
                    }
                }
            } catch (err) {
                return Promise.reject('failed to check for duped items, try sending an offer instead');
            }
        }

        this.offer.data('_dupeCheck', undefined);
    }

    private get canUseKeys(): boolean {
        if (this.getOurCount('5021;6') !== 0 || this.getTheirCount('5021;6') !== 0) {
            // The trade contains keys, don't use keys for currencies
            return false;
        }

        return this.useKeys;
    }

    /**
     * Figure our who the buyer is and get relative currencies
     */
    private get getCurrencies(): { isBuyer: boolean; currencies: Currencies } {
        const keyPrice = this.bot.pricelist.getKeyPrice;
        const [ourValue, theirValue] = [
            this.getWhichCurrencies('our').toValue(keyPrice.metal),
            this.getWhichCurrencies('their').toValue(keyPrice.metal)
        ];

        if (ourValue >= theirValue) {
            // Our value is greater, we are selling
            return {
                isBuyer: false,
                currencies: Currencies.toCurrencies(ourValue - theirValue, this.canUseKeys ? keyPrice.metal : undefined)
            };
        } else {
            // Our value is smaller, we are buying
            return {
                isBuyer: true,
                currencies: Currencies.toCurrencies(theirValue - ourValue, this.canUseKeys ? keyPrice.metal : undefined)
            };
        }
    }

    private getWhichCurrencies(which: 'our' | 'their'): Currencies {
        const keyPrice = this.bot.pricelist.getKeyPrice;

        let value = 0;

        // Go through [which] items
        for (const sku in this[which]) {
            if (!Object.prototype.hasOwnProperty.call(this[which], sku)) {
                continue;
            }

            const match = this.bot.pricelist.getPrice(sku, true);
            if (match === null) {
                // Ignore items that are no longer in the pricelist
                continue;
            }

            value += match[which === 'our' ? 'sell' : 'buy'].toValue(keyPrice.metal) * this[which][sku];
        }

        return Currencies.toCurrencies(value, this.canUseKeys ? keyPrice.metal : undefined);
    }

    private getRequired(
        buyerCurrencies: { [sku: string]: number },
        price: Currencies,
        useKeys: boolean
    ): { currencies: { [sku: string]: number }; change: number } {
        log.debug('Getting required currencies');

        const keyPrice = this.bot.pricelist.getKeyPrice;

        const currencyValues: {
            [sku: string]: number;
        } = {
            '5021;6': useKeys ? keyPrice.toValue() : -1,
            '5002;6': 9,
            '5001;6': 3,
            '5000;6': 1
        };

        const pickedCurrencies: {
            [sku: string]: number;
        } = {
            '5021;6': 0,
            '5002;6': 0,
            '5001;6': 0,
            '5000;6': 0
        };

        const skus = Object.keys(currencyValues);
        const skusCount = skus.length;

        let remaining = price.toValue(useKeys ? keyPrice.metal : undefined);

        let hasReversed = false;
        let reverse = false;
        let index = 0;

        /* eslint-disable-next-line no-constant-condition */
        while (true) {
            const key = skus[index];
            // Start at highest currency and check if we should pick that

            // Amount to pick of the currency
            let amount = remaining / currencyValues[key];
            if (amount > buyerCurrencies[key]) {
                // We need more than we have, choose what we have
                amount = buyerCurrencies[key];
            }

            if (index === skusCount - 1) {
                // If we are at the end of the list and have a postive remaining amount,
                // then we need to loop the other way and pick the value that will make the remaining 0 or negative

                if (hasReversed) {
                    // We hit the end the second time, break out of the loop
                    break;
                }

                reverse = true;
            }

            const currAmount = pickedCurrencies[key] || 0;

            if (reverse && amount > 0) {
                // We are reversing the array and found an item that we need
                if (currAmount + Math.ceil(amount) > buyerCurrencies[key]) {
                    // Amount is more than the limit, set amount to the limit
                    amount = buyerCurrencies[key] - currAmount;
                } else {
                    amount = Math.ceil(amount);
                }
            }

            if (amount >= 1) {
                // If the amount is greater than or equal to 1, then I need to pick it
                pickedCurrencies[key] = currAmount + Math.floor(amount);
                // Remove value from remaining
                remaining -= Math.floor(amount) * currencyValues[key];
            }

            log.debug('Iteration', {
                index: index,
                key: key,
                amount: amount,
                remaining: remaining,
                reverse: reverse,
                hasReversed: hasReversed,
                picked: pickedCurrencies
            });

            if (remaining === 0) {
                // Picked the exact amount, stop
                break;
            }

            if (remaining < 0) {
                // We owe them money, break out of the loop
                break;
            }

            if (index === 0 && reverse) {
                // We were reversing and then reached start of the list, say that we have reversed and go back the other way
                hasReversed = true;
                reverse = false;
            }

            index += reverse ? -1 : 1;
        }

        if (remaining < 0) {
            log.debug('Picked too much value, removing...');

            // Removes unnecessary items
            for (let i = 0; i < skusCount; i++) {
                const sku = skus[i];

                if (pickedCurrencies[sku] === undefined) {
                    continue;
                }

                let amount = Math.floor(Math.abs(remaining) / currencyValues[sku]);
                if (pickedCurrencies[sku] < amount) {
                    amount = pickedCurrencies[sku];
                }

                if (amount >= 1) {
                    remaining += amount * currencyValues[sku];
                    pickedCurrencies[sku] -= amount;
                }

                log.debug('Iteration', {
                    sku: skus[i],
                    amount: amount,
                    remaining: remaining,
                    picked: pickedCurrencies
                });
            }
        }

        log.debug('Done constructing offer', { picked: pickedCurrencies, change: remaining });

        if (this.isWeaponsAsCurrencyEnabled) {
            this.weapons.forEach(sku => {
                pickedCurrencies[sku] = 0;
            });
        }

        return {
            currencies: pickedCurrencies,
            change: remaining
        };
    }

    summarizeOur(): string[] {
        const summary = super.summarizeOur();

        const ourDict = (this.offer.data('dict') as ItemsDict).our;
        const scrap = ourDict['5000;6'] || 0;
        const reclaimed = ourDict['5001;6'] || 0;
        const refined = ourDict['5002;6'] || 0;

        let addWeapons = 0;
        if (this.isWeaponsAsCurrencyEnabled) {
            this.weapons.forEach(sku => {
                addWeapons += ourDict[sku] || 0;
            });
        }

        if (this.getCurrencies.isBuyer) {
            summary.push(
                new Currencies({
                    keys: this.canUseKeys ? ourDict['5021;6'] || 0 : 0,
                    metal: Currencies.toRefined(scrap + reclaimed * 3 + refined * 9 + addWeapons * 0.5)
                }).toString()
            );
        } else if (scrap + reclaimed + refined !== 0) {
            summary.push(
                new Currencies({
                    keys: 0,
                    metal: Currencies.toRefined(scrap + reclaimed * 3 + refined * 9 + addWeapons * 0.5)
                }).toString()
            );
        }

        return summary;
    }

    summarizeTheir(): string[] {
        const summary = super.summarizeTheir();

        const theirDict = (this.offer.data('dict') as ItemsDict).their;
        const scrap = theirDict['5000;6'] || 0;
        const reclaimed = theirDict['5001;6'] || 0;
        const refined = theirDict['5002;6'] || 0;

        let addWeapons = 0;
        if (this.isWeaponsAsCurrencyEnabled) {
            this.weapons.forEach(sku => {
                addWeapons += theirDict[sku] || 0;
            });
        }

        if (!this.getCurrencies.isBuyer) {
            summary.push(
                new Currencies({
                    keys: this.canUseKeys ? theirDict['5021;6'] || 0 : 0,
                    metal: Currencies.toRefined(scrap + reclaimed * 3 + refined * 9 + addWeapons * 0.5)
                }).toString()
            );
        } else if (scrap + reclaimed + refined !== 0) {
            summary.push(
                new Currencies({
                    keys: 0,
                    metal: Currencies.toRefined(scrap + reclaimed * 3 + refined * 9 + addWeapons * 0.5)
                }).toString()
            );
        }

        return summary;
    }

    async constructOffer(): Promise<string> {
        if (this.isEmpty) {
            return Promise.reject('cart is empty');
        }

        const offer = this.bot.manager.createOffer(this.partner);

        const alteredMessages: string[] = [];

        const whichAssetIds = {
            our: [],
            their: []
        };

        // Add our items
        const ourInventory = this.bot.inventoryManager.getInventory;
        this.ourInventoryCount = ourInventory.getTotalItems;

        for (const sku in this.our) {
            if (!Object.prototype.hasOwnProperty.call(this.our, sku)) {
                continue;
            }

            let alteredMessage: string;

            let amount = this.getOurCount(sku);
            const ourAssetids = ourInventory.findBySKU(sku, true);
            const ourAssetidsCount = ourAssetids.length;

            if (amount > ourAssetidsCount) {
                amount = ourAssetidsCount;

                // Remove the item from the cart
                this.removeOurItem(sku, Infinity);

                if (ourAssetidsCount === 0) {
                    alteredMessage =
                        "I don't have any " + pluralize(this.bot.schema.getName(SKU.fromString(sku), false));
                } else {
                    alteredMessage =
                        'I only have ' +
                        pluralize(this.bot.schema.getName(SKU.fromString(sku), false), ourAssetidsCount, true);

                    // Add the max amount to the cart
                    this.addOurItem(sku, amount);
                }
            }

            // selling order so buying is false
            const skuCount = getSkuAmountCanTrade(sku, this.bot, false);

            if (amount > skuCount.mostCanTrade) {
                this.removeOurItem(sku, Infinity);
                if (skuCount.mostCanTrade === 0) {
                    alteredMessage = `I can't sell more ${skuCount.name}`;
                    this.bot.listings.checkBySKU(sku);
                } else {
                    alteredMessage = `I can only sell ${skuCount.mostCanTrade} more ${pluralize(
                        skuCount.name,
                        skuCount.mostCanTrade
                    )}`;

                    // Add the amount we can trade
                    this.addOurItem(sku, skuCount.mostCanTrade);
                }
            }

            if (alteredMessage) {
                alteredMessages.push(alteredMessage);
            }
        }

        const opt = this.bot.options;

        // Load their inventory

        const theirInventory = new Inventory(
            this.partner,
            this.bot.manager,
            this.bot.schema,
            opt,
            this.bot.effects,
            this.bot.paints,
            this.bot.strangeParts,
            'their'
        );

        try {
            await theirInventory.fetch();
        } catch (err) {
            return Promise.reject('Failed to load inventories (Steam might be down)');
        }

        this.theirInventoryCount = theirInventory.getTotalItems;

        const inventoryDict = {
            our: ourInventory.getItems,
            their: theirInventory.getItems
        };

        // Add their items
        for (const sku in this.their) {
            if (!Object.prototype.hasOwnProperty.call(this.their, sku)) {
                continue;
            }

            let alteredMessage: string;

            let amount = this.getTheirCount(sku);
            const theirAssetids = theirInventory.findBySKU(sku, true);
            const theirAssetidsCount = theirAssetids.length;

            if (amount > theirAssetidsCount) {
                // Remove the item from the cart
                this.removeTheirItem(sku, Infinity);

                if (theirAssetidsCount === 0) {
                    alteredMessage =
                        "you don't have any " + pluralize(this.bot.schema.getName(SKU.fromString(sku), false));
                } else {
                    amount = theirAssetidsCount;
                    alteredMessage =
                        'you only have ' +
                        pluralize(this.bot.schema.getName(SKU.fromString(sku), false), theirAssetidsCount, true);

                    // Add the max amount to the cart
                    this.addTheirItem(sku, amount);
                }
            }

            const skuCount = getSkuAmountCanTrade(sku, this.bot);

            if (amount > skuCount.mostCanTrade) {
                this.removeTheirItem(sku, Infinity);
                if (skuCount.mostCanTrade === 0) {
                    alteredMessage = "I can't buy more " + pluralize(skuCount.name);
                    this.bot.listings.checkBySKU(sku);
                } else {
                    alteredMessage = `I can only buy ${skuCount.mostCanTrade} more ${pluralize(
                        skuCount.name,
                        skuCount.mostCanTrade
                    )}`;

                    // Add the amount we can trade
                    this.addTheirItem(sku, skuCount.mostCanTrade);
                }
            }

            if (alteredMessage) {
                alteredMessages.push(alteredMessage);
            }
        }

        if (this.isEmpty) {
            theirInventory.clearFetch();
            return Promise.reject(alteredMessages.join(', '));
        }

        const itemsDict: {
            our: OurTheirItemsDict;
            their: OurTheirItemsDict;
        } = {
            our: Object.assign({}, this.our),
            their: Object.assign({}, this.their)
        };

        // Done checking if buyer and seller has the items and if the bot wants to buy / sell more

        // Add values to the offer

        // Figure out who the buyer is and what they are offering
        const { isBuyer, currencies } = this.getCurrencies;

        // We now know who the buyer is, now get their inventory
        const buyerInventory = isBuyer ? ourInventory : theirInventory;

        if (this.bot.inventoryManager.amountCanAfford(this.canUseKeys, currencies, buyerInventory, []) < 1) {
            // Buyer can't afford the items
            theirInventory.clearFetch();

            return Promise.reject(
                (isBuyer ? 'I' : 'You') +
                    " don't have enough pure for this trade." +
                    (isBuyer ? '\n💰 Current pure stock: ' + pure.stock(this.bot).join(', ').toString() : '')
            );
        }

        const keyPrice = this.bot.pricelist.getKeyPrice;

        const [ourItemsValue, theirItemsValue] = [
            this.getWhichCurrencies('our').toValue(keyPrice.metal),
            this.getWhichCurrencies('their').toValue(keyPrice.metal)
        ];

        // Create exchange object with our and their items values
        const exchange = {
            our: { value: ourItemsValue, keys: 0, scrap: ourItemsValue },
            their: { value: theirItemsValue, keys: 0, scrap: theirItemsValue }
        };

        // Figure out what pure to pick from the buyer, and if change is needed

        const buyerCurrenciesWithAssetids = buyerInventory.getCurrencies(
            this.isWeaponsAsCurrencyEnabled ? this.weapons : []
        );

        const buyerCurrenciesCount = {
            '5021;6': buyerCurrenciesWithAssetids['5021;6'].length,
            '5002;6': buyerCurrenciesWithAssetids['5002;6'].length,
            '5001;6': buyerCurrenciesWithAssetids['5001;6'].length,
            '5000;6': buyerCurrenciesWithAssetids['5000;6'].length
        };

        if (this.isWeaponsAsCurrencyEnabled) {
            this.weapons.forEach(sku => {
                buyerCurrenciesCount[sku] = buyerCurrenciesWithAssetids[sku].length;
            });
        }

        const required = this.getRequired(buyerCurrenciesCount, currencies, this.canUseKeys);

        let addWeapons = 0;
        if (this.isWeaponsAsCurrencyEnabled) {
            this.weapons.forEach(sku => {
                addWeapons += (required.currencies[sku] !== undefined ? required.currencies[sku] : 0) * 0.5;
            });
        }

        // Add the value that the buyer pays to the exchange
        exchange[isBuyer ? 'our' : 'their'].value += currencies.toValue(keyPrice.metal);
        exchange[isBuyer ? 'our' : 'their'].keys += required.currencies['5021;6'];
        exchange[isBuyer ? 'our' : 'their'].scrap +=
            required.currencies['5002;6'] * 9 +
            required.currencies['5001;6'] * 3 +
            required.currencies['5000;6'] +
            addWeapons;

        // Add items to offer

        // Add our items
        for (const sku in this.our) {
            if (!Object.prototype.hasOwnProperty.call(this.our, sku)) {
                continue;
            }

            const amount = this.our[sku];
            const assetids = ourInventory.findBySKU(sku, true);
            const ourAssetidsCount = assetids.length;

            this.ourItemsCount += amount;
            let missing = amount;
            let isSkipped = false;

            for (let i = 0; i < ourAssetidsCount; i++) {
                const assetid = assetids[i];

                if (opt.miscSettings.skipItemsInTrade.enable && this.bot.trades.isInTrade(assetid)) {
                    isSkipped = true;
                    continue;
                }
                const isAdded = offer.addMyItem({
                    appid: 440,
                    contextid: '2',
                    assetid: assetid
                });

                if (isAdded) {
                    // The item was added to the offer
                    whichAssetIds.our.push(assetid);
                    missing--;
                    if (missing === 0) {
                        // We added all the items
                        break;
                    }
                }
            }

            if (missing !== 0) {
                log.warn(
                    `Failed to create offer because missing our items${
                        isSkipped ? '. Reason: Item(s) are currently being used in another active trade' : ''
                    }`,
                    {
                        sku: sku,
                        required: amount,
                        missing: missing
                    }
                );

                theirInventory.clearFetch();

                return Promise.reject(
                    `Something went wrong while constructing the offer${
                        isSkipped ? '. Reason: Item(s) are currently being used in another active trade.' : ''
                    }`
                );
            }
        }

        const assetidsToCheck: string[] = [];

        const getAssetidsWithFullUses = (items: DictItem[]) => {
            return items.filter(item => item.isFullUses === true).map(item => item.id);
        };

        // Add their items
        for (const sku in this.their) {
            if (!Object.prototype.hasOwnProperty.call(this.their, sku)) {
                continue;
            }

            const amount = this.their[sku];
            let assetids = theirInventory.findBySKU(sku, true);

            const addToDupeCheckList =
                SKU.fromString(sku).effect !== null &&
                this.bot.pricelist.getPrice(sku, true, true).buy.toValue(keyPrice.metal) >
                    this.bot.handler.minimumKeysDupeCheck * keyPrice.toValue();

            this.theirItemsCount += amount;
            let missing = amount;

            let checkedDuel = false;
            let checkNoiseMaker = false;

            if (opt.miscSettings.checkUses.duel && sku === '241;6') {
                checkedDuel = true;
                assetids = getAssetidsWithFullUses(inventoryDict.their[sku]);
            } else if (opt.miscSettings.checkUses.noiseMaker && Object.keys(noiseMakers).includes(sku)) {
                checkNoiseMaker = true;
                assetids = getAssetidsWithFullUses(inventoryDict.their[sku]);
            }

            const theirAssetidsCount = assetids.length;

            for (let i = 0; i < theirAssetidsCount; i++) {
                const assetid = assetids[i];

                const isAdded = offer.addTheirItem({
                    appid: 440,
                    contextid: '2',
                    assetid: assetid
                });

                if (isAdded) {
                    missing--;

                    whichAssetIds.their.push(assetid);

                    if (addToDupeCheckList) {
                        assetidsToCheck.push(assetid);
                    }

                    if (missing === 0) {
                        break;
                    }
                }
            }

            if (missing !== 0) {
                log.warn(
                    `Failed to create offer because missing their items${
                        checkedDuel
                            ? ' (not enough Dueling Mini-Game with 5x Uses)'
                            : checkNoiseMaker
                            ? ' (not enough Noise Maker with 25x Uses)'
                            : ''
                    }`,
                    {
                        sku: sku,
                        required: amount,
                        missing: missing
                    }
                );

                theirInventory.clearFetch();

                return Promise.reject(
                    `Something went wrong while constructing the offer${
                        checkedDuel
                            ? ' (not enough Dueling Mini-Game with 5x Uses)'
                            : checkNoiseMaker
                            ? ' (not enough Noise Maker with 25x Uses)'
                            : ''
                    }`
                );
            }
        }

        const getHighValue: GetHighValue = {
            our: {
                items: {},
                isMention: false
            },
            their: {
                items: {},
                isMention: false
            }
        };

        // Get High-value items
        ['our', 'their'].forEach(which => {
            for (const sku in inventoryDict[which]) {
                if (!Object.prototype.hasOwnProperty.call(inventoryDict[which], sku)) {
                    continue;
                }

                const whichIs = which as WhichHighValue;

                inventoryDict[whichIs][sku]
                    .filter(item => whichAssetIds[whichIs].includes(item.id))
                    .forEach(item => {
                        if (item.hv !== undefined) {
                            // If hv exist, get the high value and assign into items
                            getHighValue[whichIs].items[sku] = item.hv;

                            Object.keys(item.hv).forEach(attachment => {
                                if (attachment === 's') {
                                    // If spells exist, always mention
                                    getHighValue[whichIs].isMention = true;
                                }

                                if (attachment !== 's' && item.hv[attachment] !== undefined) {
                                    for (const pSku in item.hv[attachment]) {
                                        if (!Object.prototype.hasOwnProperty.call(item.hv[attachment], pSku)) {
                                            continue;
                                        }
                                        if (item.hv[attachment as HighValueAttachments][pSku] === true) {
                                            getHighValue[whichIs].isMention = true;
                                        }
                                    }
                                }
                            });
                        } else if (item.isFullUses !== undefined) {
                            getHighValue[whichIs].items[sku] = { isFull: item.isFullUses };
                        }
                    });
            }
        });

        const input: HighValueInput = {
            our: getHighValue.our,
            their: getHighValue.their
        };

        const highValueOut = (info: HighValueInput) => {
            return {
                items: {
                    our: info.our.items,
                    their: info.their.items
                },
                isMention: {
                    our: info.our.isMention,
                    their: info.their.isMention
                }
            } as HighValueOutput;
        };

        if (Object.keys(input.our.items).length > 0 || Object.keys(input.their.items).length > 0) {
            offer.data('highValue', highValueOut(input));
        }

        if (required.change !== 0) {
            let change = Math.abs(required.change);

            exchange[isBuyer ? 'their' : 'our'].value += change;
            exchange[isBuyer ? 'their' : 'our'].scrap += change;

            const currencies = (isBuyer ? theirInventory : ourInventory).getCurrencies(
                this.isWeaponsAsCurrencyEnabled ? this.weapons : []
            ); // sellerInventory

            // We won't use keys when giving change
            delete currencies['5021;6'];

            let isSkipped = false;

            for (const sku in currencies) {
                if (!Object.prototype.hasOwnProperty.call(currencies, sku)) {
                    continue;
                }

                let value = 0;

                if (sku === '5002;6') {
                    value = 9;
                } else if (sku === '5001;6') {
                    value = 3;
                } else if (sku === '5000;6') {
                    value = 1;
                } else if (
                    this.isWeaponsAsCurrencyEnabled &&
                    this.weapons.includes(sku) &&
                    this.bot.pricelist.getPrice(sku, true) === null
                ) {
                    value = 0.5;
                }

                if (change / value >= 1) {
                    const whose = isBuyer ? 'their' : 'our';

                    const currenciesCount = currencies[sku].length;

                    for (let i = 0; i < currenciesCount; i++) {
                        const assetid = currencies[sku][i];

                        if (
                            !isBuyer &&
                            opt.miscSettings.skipItemsInTrade.enable &&
                            this.bot.trades.isInTrade(assetid)
                        ) {
                            isSkipped = true;
                            continue;
                        }
                        const isAdded = offer[isBuyer ? 'addTheirItem' : 'addMyItem']({
                            assetid: assetid,
                            appid: 440,
                            contextid: '2',
                            amount: 1
                        });

                        if (isAdded) {
                            log.debug('Added changes:', {
                                whose: whose,
                                sku: sku,
                                assetid: currencies[sku][i]
                            });

                            const amount = (itemsDict[whose][sku] || 0) + 1;
                            itemsDict[whose][sku] = amount;

                            if (whose === 'our') {
                                this.ourItemsCount += amount;
                            } else {
                                this.theirItemsCount += amount;
                            }

                            change -= value;

                            if (change < value) {
                                break;
                            }
                        }
                    }
                }
            }

            if (change !== 0) {
                theirInventory.clearFetch();

                return Promise.reject(
                    `I am missing ${Currencies.toRefined(change)} ref as change${
                        isSkipped ? ' (probably because some of the pure are in another active trade)' : ''
                    }`
                );
            }
        }

        for (const sku in required.currencies) {
            if (!Object.prototype.hasOwnProperty.call(required.currencies, sku)) {
                continue;
            }

            if (required.currencies[sku] === 0) {
                continue;
            }

            const amount = required.currencies[sku];
            itemsDict[isBuyer ? 'our' : 'their'][sku] = amount;

            if (isBuyer) {
                this.ourItemsCount += amount;
            } else {
                this.theirItemsCount += amount;
            }

            let isSkipped = false;

            const buyerCurrenciesWithAssetidsCount = buyerCurrenciesWithAssetids[sku].length;

            for (let i = 0; i < buyerCurrenciesWithAssetidsCount; i++) {
                const assetid = buyerCurrenciesWithAssetids[sku][i];

                if (isBuyer && opt.miscSettings.skipItemsInTrade.enable && this.bot.trades.isInTrade(assetid)) {
                    isSkipped = true;
                    continue;
                }
                const isAdded = offer[isBuyer ? 'addMyItem' : 'addTheirItem']({
                    assetid: assetid,
                    appid: 440,
                    contextid: '2',
                    amount: 1
                });

                if (isAdded) {
                    required.currencies[sku]--;
                    if (required.currencies[sku] === 0) {
                        break;
                    }
                }
            }

            if (required.currencies[sku] !== 0) {
                log.warn('Failed to create offer because missing buyer pure', {
                    requiredCurrencies: required.currencies,
                    sku: sku
                });

                theirInventory.clearFetch();

                return Promise.reject(
                    `Something went wrong while constructing the offer${
                        isSkipped ? ' (probably because some of the pure are in another active trade)' : ''
                    }`
                );
            }
        }

        const itemPrices: Prices = {};

        for (const sku in this.our) {
            if (!Object.prototype.hasOwnProperty.call(this.our, sku)) {
                continue;
            }

            itemPrices[sku] = {
                buy: this.bot.pricelist.getPrice(sku, true).buy,
                sell: this.bot.pricelist.getPrice(sku, true).sell
            };
        }

        for (const sku in this.their) {
            if (!Object.prototype.hasOwnProperty.call(this.their, sku)) {
                continue;
            }

            if (itemPrices[sku] !== undefined) {
                continue;
            }

            itemPrices[sku] = {
                buy: this.bot.pricelist.getPrice(sku, true).buy,
                sell: this.bot.pricelist.getPrice(sku, true).sell
            };
        }

        // Doing this so that the prices will always be displayed as only metal
        if (opt.miscSettings.showOnlyMetal.enable) {
            exchange.our.scrap += exchange.our.keys * keyPrice.toValue();
            exchange.our.keys = 0;
            exchange.their.scrap += exchange.their.keys * keyPrice.toValue();
            exchange.their.keys = 0;
        }

        offer.data('dict', itemsDict);
        offer.data('value', {
            our: {
                total: exchange.our.value,
                keys: exchange.our.keys,
                metal: Currencies.toRefined(exchange.our.scrap)
            },
            their: {
                total: exchange.their.value,
                keys: exchange.their.keys,
                metal: Currencies.toRefined(exchange.their.scrap)
            },
            rate: keyPrice.metal
        });
        offer.data('prices', itemPrices);

        offer.data('_dupeCheck', assetidsToCheck);

        this.offer = offer;

        // clear memory
        theirInventory.clearFetch();

        return alteredMessages.length === 0 ? undefined : alteredMessages.join(', ');
    }

    // We Override the toString function so that the currencies are added
    toString(): string {
        if (this.isEmpty) {
            return 'Your cart is empty.';
        }

        const { isBuyer, currencies } = this.getCurrencies;

        let str = '🛒== YOUR CART ==🛒';

        str += '\n\nMy side (items you will receive):';
        for (const sku in this.our) {
            if (!Object.prototype.hasOwnProperty.call(this.our, sku)) {
                continue;
            }

            str += `\n- ${this.our[sku]}x ${this.bot.schema.getName(SKU.fromString(sku), false)}`;
        }

        if (isBuyer) {
            // We don't offer any currencies, add their currencies to cart string because we are buying their value
            str += '\n' + (Object.keys(this.our).length === 0 ? '' : 'and ') + currencies.toString();
        }

        str += '\n\nYour side (items you will lose):';
        for (const sku in this.their) {
            if (!Object.prototype.hasOwnProperty.call(this.their, sku)) {
                continue;
            }

            str += `\n- ${this.their[sku]}x ${this.bot.schema.getName(SKU.fromString(sku), false)}`;
        }

        if (!isBuyer) {
            // They don't offer any currencies, add our currencies to cart string because they are buying our value
            str += '\n' + (Object.keys(this.their).length === 0 ? '' : 'and ') + currencies.toString();
        }
        str += '\n\nType !checkout to checkout and proceed trade, or !clearcart to cancel.';

        return str;
    }
}

interface GetHighValue {
    our: Which;
    their: Which;
}

interface Which {
    items: Record<string, any>;
    isMention: boolean;
}
