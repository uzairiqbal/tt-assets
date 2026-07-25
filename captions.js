'use strict';
/*
 * 25 rotating sell-oriented captions for TShirts & Trousers (Pakistan market).
 * Optimized for views, saves, and DM conversions.
 * pick() returns a random caption on every call.
 */

const CAPTIONS = [

`🔥 Fresh drop. Limited pieces.
Ye wala jaane wala hai — abhi order karo.

📩 DM "ORDER" + your size
🚚 COD available | Delivering all over Pakistan

#TShirtsAndTrousers #NewDrop #PakistanFashion #LimitedStock #MensFashionPK`,

`Scroll rok. 👀
Ye tshirt tumhare wardrobe ka missing piece hai.

Premium fabric. Clean cuts. Real price.
📩 DM to order | All sizes available

#AffordableFashion #PakistanStyle #MensFashion #OOTDPK #ShopPakistan`,

`Kitne log SAVE karenge ye post? 👇
Kyunke ye wali bik jaati hai fast.

📩 DM your size before it's gone
🚚 Nationwide delivery | COD available

#TShirtsAndTrousers #ViralFashionPK #PakFashion #MensWear #StreetStylePK`,

`Simple. Clean. Yours. ✨

Jab outfit sahi ho toh confidence apne aap aata hai.
📩 DM to order — limited stock only.

🚚 Delivering across Pakistan | COD available
#PakistanMensFashion #CleanAesthetic #UrbanPK #OOTD #EverydayStyle`,

`Apne dost ko tag karo jisko ye chahiye. 👇

Quality kapray. Affordable price. No excuses.
📩 DM to order | Sizes: S M L XL XXL

🚚 Fast delivery nationwide | COD available
#TagAFriend #PakistanFashion #BudgetFashion #MensStyle #ShopPK`,

`Ye rang? Game changer hai. 🎯

Har outfit pe fit hota hai. Office, casual, outing — sab perfect.
📩 DM "SIZE" to order yours now.

🚚 COD | All cities covered
#ColourOfTheDay #PakistanStyle #MensFashionPK #FreshFit #TShirtsAndTrousers`,

`Students! 📢
Premium quality. Student-friendly price. 💰

Jeb bhi khush. Style bhi top.
📩 DM to order — we got your size.
🚚 Delivering to your city | COD available

#StudentFashion #BudgetFitPK #PakistanMensFashion #AffordableStyle #CampusOOTD`,

`Roz naya outfit chahiye? 🤔
Ek ye tshirt lo — baaki sab set hai.

Versatile. Comfortable. Statement.
📩 DM to order | Limited stock

🚚 COD | Nationwide delivery
#EverydayWear #PakistanFashion #WardrobeEssential #MensWearPK #TShirtsAndTrousers`,

`Pakistan mein yahi toh milta hai —
Asli quality, asli price. 🇵🇰

No overpricing. No compromise.
📩 DM to grab yours before stock ends.
🚚 COD available | All cities

#MadeForPakistan #ShopLocal #PakistanFashion #QualityFirst #MensFashionPK`,

`Comfort + style = ye tshirt. 🔑

Jab feel bhi sahi ho aur dikhna bhi acha — yahi toh chahiye na.
📩 DM to order | Sizes available

🚚 Nationwide delivery | COD
#ComfortableStyle #PakistanOOTD #MensFashion #UrbanWear #TShirtsAndTrousers`,

`⚠️ Stock almost khatam.
Abhi order karo — baad mein available nahi hoga.

📩 DM "ORDER" with your size
🚚 Express delivery available | COD

#LimitedEdition #PakistanFashion #LastChance #MensWear #ShopNowPK`,

`Ye tshirt save karo 🔖
Kyunke jab chahoge toh stock nahi hoga. 😅

📩 DM to order while it lasts
🚚 Delivering all over Pakistan | COD

#SaveThisPost #PakistanStyle #FashionAlert #MensFashionPK #TShirtsAndTrousers`,

`Eid ke baad bhi sale chal rahi hai. 🎉
Apne aap ko treat karo — deserve karte ho.

Premium tshirts. Unbeatable prices.
📩 DM to order | All sizes

🚚 COD | Fast nationwide delivery
#PostEidVibes #PakistanFashion #SaleAlert #MensStyle #AffordablePK`,

`Outfit of the day? Sorted. ✅

Jab pehenna ho kuch alag — ye hai answer.
Simple. Bold. Pakistani.

📩 DM to order | COD available
🚚 Delivering Pakistan-wide

#OOTDPK #DailyFit #PakistanMensFashion #StyleGoals #TShirtsAndTrousers`,

`Yaar ne pucha — ye kaahan se liya? 😏
Ab tujhe bhi pata hai.

📩 DM to order your size
🚚 COD | Delivering all over Pakistan

#Drip #PakistanStreetStyle #MensFashion #FreshFit #ShopPakistan`,

`Ghar baith ke order karo. 🏠
Hum deliver karein ge tumhare darwaze tak.

Premium quality tshirts | COD available
📩 DM "ORDER + SIZE" to get yours

🚚 Nationwide delivery across Pakistan
#ShopFromHome #CODPakistan #PakistanFashion #EasyOrder #TShirtsAndTrousers`,

`Ek achha tshirt sab kuch badal deta hai. 💫

Aaj khud ke liye invest karo.
📩 DM to order | Limited pieces available

🚚 COD | All cities covered
#InvestInStyle #PakistanMensFashion #QualityOverQuantity #FreshFit #MensWearPK`,

`Comment karo: "WANT" agar ye chahiye 👇

Jitne want — utna restock karein ge. 🔥
📩 DM to order NOW | COD available

🚚 Nationwide delivery
#CommentWant #PakistanFashion #DropAlert #MensStyle #TShirtsAndTrousers`,

`Lahore 🏙️ Karachi 🌊 Islamabad 🏔️
Sab cities mein deliver karte hain.

Premium tshirts | Real prices | COD available
📩 DM to order your size now

#PakistanDelivery #ShopPK #MensFashionPK #NationwideDelivery #TShirtsAndTrousers`,

`Weekend ka plan? 🤷‍♂️
Outfit toh sort kar lo pehle.

Fresh tshirt. Fresh vibes. Simple.
📩 DM to order | Sizes available

🚚 COD | Delivering across Pakistan
#WeekendOOTD #PakistanStyle #CasualWear #MensFashion #TShirtsAndTrousers`,

`Apni ammi ko bolo — birthday gift sorted hai. 🎁

Premium tshirts | Gift-worthy quality
📩 DM to order | Gift wrapping available

🚚 COD | Delivering all over Pakistan
#GiftIdea #BirthdayGift #PakistanFashion #MensWear #ShopPK`,

`Koi fancy reason nahi chahiye. 🙌
Bas acha kapra pehnne ka dil kiya — order karo.

📩 DM "SIZE" to order
🚚 COD available | Nationwide delivery

#TreatYourself #PakistanFashion #MensStyle #SimpleStyle #TShirtsAndTrousers`,

`Winter aa raha hai ❄️
Ab jo chahiye — abhi lo. Price baad mein badh sakta hai.

📩 DM to order | Stock limited
🚚 Fast delivery | COD available

#WinterFashion #PakistanWinter #MensFashionPK #LayeredLook #TShirtsAndTrousers`,

`Tumhara favorite rang kaun sa hai? 👇 Comment mein batao!

Hum woh bhi laate hain. 😉
📩 DM for custom color requests

🚚 Delivering all over Pakistan | COD available
#FavouriteColour #CustomOrder #PakistanFashion #MensWear #TShirtsAndTrousers`,

`Bas ek tshirt chahiye tha —
Ab duniya jeet lo. 👊

Premium quality. Affordable price. Zero regrets.
📩 DM to order | Limited stock

🚚 COD | Nationwide delivery all over Pakistan
#TShirtsAndTrousers #PakistanFashion #WinTheDay #MensStyle #ShopPK`,

];

function pick() {
  return CAPTIONS[Math.floor(Math.random() * CAPTIONS.length)];
}

module.exports = { pick, CAPTIONS };
