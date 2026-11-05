import { defineMessages } from "../../message";

export const messages = defineMessages("billing", {
  // The Billing tab in Settings and the Billing dialog in the web client.
  // For example "Standard · 50 GB".
  // {amount} is a formatted price, for example "€40".
  // The commercial license of the account, above the server plans.
  // A badge on the row of what the account has now, above the commercial license offer.
  // The row under the current license row that sells a license. {count} is the smallest Team license.
  // {used} people use the license; it is paid for {users}.
  // For example "3 more users × €15".
  // {currency} is a currency code, for example "EUR".
  // {owners} is a list of names, for example "Ana and Jan".
  // The order form: a hosted server and a license in one order. The pricing page and Billing show it.
  // {percent} is a whole number, such as 20.
  // {size} is a whole number of gigabytes.
  // {speed} is how many times faster than the Starter server, such as 2.
  // {percent} is a whole number, such as 20.
  // {included} is the number of members in the base price. {price} is the monthly price of one more member.
  // {plan} is a server plan name, such as Standard.
  // {percent} is a whole number, such as 20.
  // The unit beside the total for a visitor in the EU: the prices do not include VAT.
  // Shown before an invite that makes the license too small.
});
