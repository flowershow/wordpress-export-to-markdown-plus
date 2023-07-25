const fs = require("fs");
const path = require("path")
const luxon = require("luxon");
const xml2js = require("xml2js");

const shared = require("./shared");
const settings = require("./settings");
const translator = require("./translator");

async function parseFilePromise(config) {
  console.log("\nParsing...");
  const content = await fs.promises.readFile(config.input, "utf8");
  const data = await xml2js.parseStringPromise(content, {
    trim: true,
    tagNameProcessors: [xml2js.processors.stripPrefix],
  });

  const postTypes = getPostTypes(data, config);
  const posts = collectPosts(data, postTypes, config);

  const images = [];
  if (config.saveAttachedImages) {
    images.push(...collectAttachedImages(data));
  }
  if (config.saveScrapedImages) {
    images.push(...collectScrapedImages(data, postTypes));
  }

  mergeImagesIntoPosts(images, posts, config);

  return posts;
}

function getPostTypes(data, config) {
  if (config.includeOtherTypes) {
    // search export file for all post types minus some default types we don't want
    // effectively this will be 'post', 'page', and custom post types
    const types = data.rss.channel[0].item
      .map((item) => item.post_type[0])
      .filter(
        (type) =>
          ![
            "attachment",
            "revision",
            "nav_menu_item",
            "custom_css",
            "customize_changeset",
            "mc4wp-form",
            "wp_global_styles",
          ].includes(type)
      );
    return [...new Set([...types, "authors"])]; // remove duplicates
  } else {
    // just plain old vanilla "post" posts
    return ["post"];
  }
}

function getItemsOfType(data, type) {
  return data.rss.channel[0].item.filter((item) => item.post_type[0] === type);
}

function collectPosts(data, postTypes, config) {
  // this is passed into getPostContent() for the markdown conversion
  const turndownService = translator.initTurndownService();

  let allPosts = [];
  postTypes.forEach((postType) => {
    //use slice before filter for testing smaller amounts
    const postsForType = postType === "authors" 
      ? collectAuthors(data)
      : getItemsOfType(data, postType)
        .filter(
          (post) => post.status[0] !== "trash" && post.status[0] !== "draft"
        )
        .map((post) => ({
          // meta data isn't written to file, but is used to help with other things
          meta: {
            id: getPostId(post),
            slug: getPostSlug(post),
            coverImageId: getPostCoverImageId(post),
            type: postType,
            imageUrls: [],
          },
          frontmatter: {
            title: getPostTitle(post),
            created: getPostDate(post),
            date: getPostDate(post),
            categories: getCategories(post),
            tags: getTags(post),
            authors: getAuthors(post)
          },
          content: translator.getPostContent(post, turndownService, config),
        }));

    if (postTypes.length > 1) {
      console.log(`${postsForType.length} "${postType}" ${postType === "authors" ? "with" : ""} posts found.`);
    }

    allPosts.push(...postsForType);
  });

  if (postTypes.length === 1) {
    console.log(allPosts.length + " posts found.");
  }

  return allPosts;
}

function getPostId(post) {
  return post.post_id[0];
}

function getPostSlug(post) {
  return decodeURIComponent(post.post_name[0]);
}

function getPostCoverImageId(post) {
  if (post.postmeta === undefined) {
    return undefined;
  }

  const postmeta = post.postmeta.find(
    (postmeta) => postmeta.meta_key[0] === "_thumbnail_id"
  );
  const id = postmeta ? postmeta.meta_value[0] : undefined;
  return id;
}

function getPostTitle(post) {
  // if title has Html in it, return the post name instead
  const re = /^</;
  if (re.test(post.title[0])) {
    const title = post.post_name[0].replace("-", " ")
    // capitalize each word
    return title.replace(/(^\w|\s\w)(\S*)/g, (_,m1,m2) => m1.toUpperCase()+m2.toLowerCase());
  } else {
    return post.title[0];
  }
}

function getAuthors(post) {
  return post.creator[0].split(" and ").map(author => author.toLowerCase().replace(" ", "-"))
}

function getAuthorsWithPosts(data) {
  let authors = []
  const authorList = data.rss.channel[0].author
  const posts = data.rss.channel[0].item.filter(
    (post) => post.status[0] !== "trash" && post.status[0] !== "draft" && post.post_type[0] !== "attachment"
  )
  authorList.map(author => {
    const authorWithPost = posts.some(post => post.creator.includes(author['author_login'][0]))
    if (authorWithPost) authors.push(author)
  })
  return authors
}

function collectAuthors(data) {
  const authors = getAuthorsWithPosts(data)
    .map(author => {
      const slug = author['author_login'][0].toLowerCase().replace(" ", "-")
      const displayName = author['author_display_name'][0]
      const firstName = author['author_first_name'][0]
      const lastName = author['author_last_name'][0]

      return ({
        meta: {
          id: slug,
          slug: decodeURIComponent(slug),
          type: "authors",
          imageUrls: [],
        },
        frontmatter: {
          id: slug,
          name: firstName && lastName
            ? `${firstName} ${lastName}`
            : displayName
        },
      })
    })

  return authors
}

function getPostDate(post) {
  const dateTime = luxon.DateTime.fromRFC2822(post.pubDate[0], { zone: "utc" });

  if (settings.custom_date_formatting) {
    return dateTime.toFormat(settings.custom_date_formatting);
  } else if (settings.include_time_with_date) {
    return dateTime.toISO();
  } else {
    return dateTime.toISODate();
  }
}

function getCategories(post) {
  const categories = processCategoryTags(post, "category");
  return categories.filter(
    (category) => !settings.filter_categories.includes(category)
  );
}

function getTags(post) {
  return processCategoryTags(post, "post_tag");
}

function processCategoryTags(post, domain) {
  if (!post.category) {
    return [];
  }

  return post.category
    .filter((category) => category.$.domain === domain)
    .map(({ $: attributes }) => decodeURIComponent(attributes.nicename));
}

function collectAttachedImages(data) {
  const images = getItemsOfType(data, "attachment")
    // filter to certain image file types
    .filter((attachment) =>
      /\.(gif|jpe?g|png|svg|webp|pdf)$/i.test(attachment.attachment_url[0])
    )
    .map((attachment) => ({
      id: attachment.post_id[0],
      postId: attachment.post_parent[0],
      url: attachment.attachment_url[0],
    }));

  console.log(images.length + " attached images found.");
  return images;
}

function collectScrapedImages(data, postTypes) {
  const images = [];
  postTypes.forEach((postType) => {
    getItemsOfType(data, postType).forEach((post) => {
      const postId = post.post_id[0];
      const postContent = post.encoded[0];
      const postLink = post.link[0];

      const matches = [
        ...postContent.matchAll(
          /<img[^>]*src="(.+?\.(?:gif|jpe?g|png|svg|webp))"[^>]*>/gi
        ),
      ];
      matches.forEach((match) => {
        // base the matched image URL relative to the post URL
        const url = new URL(match[1], postLink).href;
        images.push({
          id: -1,
          postId: postId,
          url,
        });
      });
    });
  });

  console.log(images.length + " images scraped from post body content.");
  return images;
}

function mergeImagesIntoPosts(images, posts, config) {
  images.forEach((image) => {
    posts.forEach((post) => {
      let shouldAttach = false;

      // this image was uploaded as an attachment to this post
      if (image.postId === post.meta.id) {
        shouldAttach = true;
      }

      // this image was set as the featured image for this post
      if (image.id === post.meta.coverImageId) {
        shouldAttach = true;
        post.frontmatter.image = path.join(`/${config.assets}`, "images", shared.getFilenameFromUrl(image.url));
      }

      if (shouldAttach && !post.meta.imageUrls.includes(image.url)) {
        post.meta.imageUrls.push(image.url);
      }
    });
  });
}

exports.parseFilePromise = parseFilePromise;
